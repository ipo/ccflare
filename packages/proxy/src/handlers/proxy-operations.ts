import { logError, ProviderError } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type { Account, RequestMeta } from "@ccflare/types";
import { forwardToClient } from "../response-handler";
import { ERROR_MESSAGES, type ResolvedProxyContext } from "./proxy-types";
import { makeProxyRequest } from "./request-handler";
import { handleProxyError, processProxyResponse } from "./response-processor";
import { getValidAccessToken } from "./token-manager";

const log = new Logger("ProxyOperations");

export type ProxyAttemptOutcome =
	| { kind: "forwarded"; response: Response }
	| {
			kind: "rate_limited";
			response: Response;
			account: Account;
			resetTime?: number;
			upstreamRequestStartedAt: number;
			responseHeadersReceivedAt: number;
	  }
	| { kind: "failed" };

/**
 * Handles proxy request without authentication
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param ctx - The proxy context
 * @returns Promise resolving to the response
 * @throws {ProviderError} If the unauthenticated request fails
 */
export async function proxyUnauthenticated(
	req: Request,
	url: URL,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	ctx: ResolvedProxyContext,
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);
	if (ctx.providerName === "grok") {
		return ctx.provider.buildProxyErrorResponse({
			kind: "service_unavailable",
			message:
				"Grok requires a connected OAuth account; start login with POST /api/auth/grok/init",
		});
	}

	const targetUrl = ctx.provider.buildUrl(ctx.upstreamPath, url.search);
	const headers = ctx.provider.prepareHeaders(req.headers, null);

	try {
		const upstreamRequestStartedAt = Date.now();
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
		);
		const responseHeadersReceivedAt = Date.now();

		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: requestMeta.method,
				path: url.pathname,
				account: null,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response,
				timestamp: requestMeta.timestamp,
				upstreamRequestStartedAt,
				responseHeadersReceivedAt,
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);
	} catch (error) {
		logError(error, log);
		throw new ProviderError(
			ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
			ctx.providerName,
			502,
			{
				originalError: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

/**
 * Attempts to proxy a request with a specific account
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param account - The account to use
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param failoverAttempts - Number of failover attempts
 * @param ctx - The proxy context
 * @returns The forwarded response, retained rate-limit attempt, or failure
 */
export async function proxyWithAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	failoverAttempts: number,
	ctx: ResolvedProxyContext,
): Promise<ProxyAttemptOutcome> {
	try {
		log.info(`Attempting request with account: ${account.name}`);

		// Get valid access token
		const accessToken = await getValidAccessToken(account, ctx);

		// Prepare request
		const requestAccount =
			accessToken === account.access_token
				? account
				: { ...account, access_token: accessToken };
		const headers = ctx.provider.prepareHeaders(req.headers, requestAccount);
		const targetUrl = ctx.provider.buildUrl(
			ctx.upstreamPath,
			url.search,
			account,
		);

		// Make the request
		const upstreamRequestStartedAt = Date.now();
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
		);
		const responseHeadersReceivedAt = Date.now();

		// Process response and check for rate limit
		const rateLimitInfo = processProxyResponse(response, account, ctx);
		if (rateLimitInfo) {
			return {
				kind: "rate_limited",
				response,
				account,
				resetTime: rateLimitInfo.resetTime,
				upstreamRequestStartedAt,
				responseHeadersReceivedAt,
			};
		}

		// Forward response to client
		return {
			kind: "forwarded",
			response: await forwardToClient(
				{
					requestId: requestMeta.id,
					method: requestMeta.method,
					path: url.pathname,
					account,
					requestHeaders: req.headers,
					requestBody: requestBodyBuffer,
					response,
					timestamp: requestMeta.timestamp,
					upstreamRequestStartedAt,
					responseHeadersReceivedAt,
					retryAttempt: 0,
					failoverAttempts,
				},
				ctx,
			),
		};
	} catch (err) {
		handleProxyError(err, account, log);
		return { kind: "failed" };
	}
}
