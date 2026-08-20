import { requestEvents, ServiceUnavailableError } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import {
	extractClientSessionIdFromHeaders,
	isRequestSummary,
} from "@ccflare/types";
import {
	createRequestMetadata,
	ERROR_MESSAGES,
	getAccountAvailability,
	type ProxyAttemptOutcome,
	type ProxyContext,
	prepareRequestBody,
	proxyUnauthenticated,
	proxyWithAccount,
	resolveProxyContext,
	TIMING,
} from "./handlers";
import { forwardToClient } from "./response-handler";
import {
	UsageWorkerController,
	type UsageWorkerHealthSnapshot,
	type UsageWorkerTransport,
} from "./usage-worker";

export type { ProxyContext } from "./handlers";

const log = new Logger("Proxy");

function retryAfterSeconds(retryAt: number): number {
	return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
}

function withDerivedRetryAfter(response: Response, retryAt?: number): Response {
	if (response.headers.has("retry-after") || retryAt === undefined) {
		return response;
	}

	const headers = new Headers(response.headers);
	headers.set("retry-after", String(retryAfterSeconds(retryAt)));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

let usageWorkerInstance: UsageWorkerController | null = null;

/**
 * Gets or creates the usage worker instance
 * @returns The usage worker instance
 */
export function getUsageWorker(): UsageWorkerTransport {
	if (!usageWorkerInstance) {
		usageWorkerInstance = new UsageWorkerController({
			logger: log,
			shutdownDelayMs: TIMING.WORKER_SHUTDOWN_DELAY,
			onWorkerMessage: (data) => {
				if (data.type === "summary" && isRequestSummary(data.summary)) {
					requestEvents.emit("event", {
						type: "summary",
						payload: data.summary,
					});
				}
			},
		});
	}
	return usageWorkerInstance;
}

export function getUsageWorkerHealth(): UsageWorkerHealthSnapshot {
	return (
		usageWorkerInstance?.getHealthSnapshot() ?? {
			state: "stopped",
			queuedMessages: 0,
			pendingAcks: 0,
			lastError: null,
		}
	);
}

/**
 * Gracefully terminates the usage worker
 */
export async function terminateUsageWorker(): Promise<void> {
	if (usageWorkerInstance) {
		const activeWorker = usageWorkerInstance;
		try {
			await usageWorkerInstance.terminateGracefully();
		} finally {
			if (
				usageWorkerInstance === activeWorker &&
				activeWorker.wasTerminatedSafely()
			) {
				usageWorkerInstance = null;
			}
		}
	}
}

/**
 * Main proxy handler - orchestrates the entire proxy flow
 *
 * This function coordinates the proxy process by:
 * 1. Creating request metadata for tracking
 * 2. Preparing the request body for reuse
 * 3. Selecting accounts based on load balancing strategy
 * 4. Attempting to proxy with each account in order
 * 5. Falling back to unauthenticated proxy if no accounts available
 *
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param ctx - The proxy context containing strategy, database, and provider
 * @returns Promise resolving to the proxied response
 * @throws {ServiceUnavailableError} If all accounts fail to proxy the request
 * @throws {ProviderError} If unauthenticated proxy fails
 */
export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
): Promise<Response> {
	const requestContext = resolveProxyContext(url, ctx);
	if (!requestContext) {
		return new Response("Not Found", { status: 404 });
	}
	if (
		requestContext.providerName === "grok" &&
		requestContext.upstreamPath !== "/responses"
	) {
		return new Response("Not Found", { status: 404 });
	}
	if (requestContext.providerName === "grok" && req.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { allow: "POST" },
		});
	}

	// 1. Create request metadata before any buffering work so total timing
	// includes proxy-side request preparation overhead.
	const requestMeta = createRequestMetadata(req, url);
	requestEvents.emit("event", {
		type: "ingress",
		id: requestMeta.id,
		timestamp: requestMeta.timestamp,
		method: requestMeta.method,
		path: requestMeta.path,
		clientSessionId: extractClientSessionIdFromHeaders(
			Object.fromEntries(req.headers.entries()),
		),
	});

	// 2. Prepare request body
	const { buffer: requestBodyBuffer } = await prepareRequestBody(req);

	// 3. An empty candidate set is not itself permission to use caller auth.
	const availability = getAccountAvailability(requestMeta, requestContext);
	if (availability.kind === "no_configured_accounts") {
		return proxyUnauthenticated(
			req,
			url,
			requestMeta,
			requestBodyBuffer,
			() => {
				if (!requestBodyBuffer) return undefined;
				return new Response(requestBodyBuffer).body ?? undefined;
			},
			requestContext,
		);
	}
	if (
		availability.kind === "cooling_down" ||
		availability.kind === "unavailable"
	) {
		const coolingDown = availability.kind === "cooling_down";
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: requestMeta.method,
				path: url.pathname,
				account: null,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response: requestContext.provider.buildProxyErrorResponse({
					kind: coolingDown ? "rate_limit" : "service_unavailable",
					message: coolingDown
						? "All managed accounts are rate limited"
						: "Managed accounts are unavailable",
					retryAfterSeconds: coolingDown
						? retryAfterSeconds(availability.retryAt)
						: undefined,
				}),
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			requestContext,
		);
	}

	const accounts = availability.accounts;
	const rateLimitedAttempts: Array<
		Extract<ProxyAttemptOutcome, { kind: "rate_limited" }>
	> = [];

	// 5. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	log.info(`Request: ${req.method} ${url.pathname}`);

	// 6. Try each account
	for (let i = 0; i < accounts.length; i++) {
		const outcome = await proxyWithAccount(
			req,
			url,
			accounts[i],
			requestMeta,
			requestBodyBuffer,
			() => {
				if (!requestBodyBuffer) return undefined;
				return new Response(requestBodyBuffer).body ?? undefined;
			},
			i,
			requestContext,
		);

		if (outcome.kind === "forwarded") {
			return outcome.response;
		}
		if (outcome.kind === "rate_limited") {
			rateLimitedAttempts.push(outcome);
		}
	}

	if (rateLimitedAttempts.length > 0) {
		const retained = rateLimitedAttempts[0];
		const earliestReset = rateLimitedAttempts.reduce<number | undefined>(
			(earliest, attempt) =>
				attempt.resetTime === undefined
					? earliest
					: earliest === undefined
						? attempt.resetTime
						: Math.min(earliest, attempt.resetTime),
			undefined,
		);
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: requestMeta.method,
				path: url.pathname,
				account: retained.account,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response: withDerivedRetryAfter(retained.response, earliestReset),
				timestamp: requestMeta.timestamp,
				upstreamRequestStartedAt: retained.upstreamRequestStartedAt,
				responseHeadersReceivedAt: retained.responseHeadersReceivedAt,
				retryAttempt: 0,
				failoverAttempts: accounts.length - 1,
			},
			requestContext,
		);
	}

	// 7. All managed attempts failed without a rate-limit response.
	throw new ServiceUnavailableError(
		`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${accounts.length} attempted)`,
		requestContext.providerName,
	);
}
