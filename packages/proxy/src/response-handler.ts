import { requestEvents } from "@ccflare/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@ccflare/http";
import {
	type Account,
	extractClientSessionIdFromHeaders,
	type HttpMethod,
	isRecord,
} from "@ccflare/types";
import { trackProxyBackgroundTask } from "./background-tasks";
import type { ResolvedProxyContext } from "./handlers";
import type { ChunkMessage, EndMessage, StartMessage } from "./worker-messages";

/**
 * Check if a response should be considered successful/expected
 * Treats certain well-known paths that return 404 as expected
 */
function isExpectedResponse(path: string, response: Response): boolean {
	// Any .well-known path returning 404 is expected
	if (path.startsWith("/.well-known/") && response.status === 404) {
		return true;
	}

	// Otherwise use standard HTTP success logic
	return response.ok;
}

export interface ResponseHandlerOptions {
	requestId: string;
	method: HttpMethod;
	path: string;
	account: Account | null;
	requestHeaders: Headers;
	requestBody: ArrayBuffer | null;
	response: Response;
	timestamp: number;
	upstreamRequestStartedAt?: number;
	responseHeadersReceivedAt?: number;
	retryAttempt: number;
	failoverAttempts: number;
	preExtractedModel?: string;
	upstreamRequestIsStreaming?: boolean;
}

function requestBodyEnablesStreaming(requestBody: ArrayBuffer | null): boolean {
	if (!requestBody) return false;

	try {
		const parsed = JSON.parse(new TextDecoder().decode(requestBody));
		return isRecord(parsed) && parsed.stream === true;
	} catch {
		return false;
	}
}

function classifyStreamingResponse(
	response: Response,
	providerDetectedStream: boolean,
	upstreamRequestIsStreaming: boolean | undefined,
	requestBody: ArrayBuffer | null,
): boolean {
	if (providerDetectedStream) return true;
	if (!response.body) return false;

	// Codex can return SSE without a content-type header. In that case, use
	// request intent, but never override an explicit non-SSE response type.
	if (response.headers.get("content-type")?.trim()) return false;
	if (upstreamRequestIsStreaming !== undefined) {
		return upstreamRequestIsStreaming;
	}
	return requestBodyEnablesStreaming(requestBody);
}

/**
 * Unified response handler that immediately streams responses
 * while forwarding data to worker for async processing.
 */
export async function forwardToClient(
	options: ResponseHandlerOptions,
	ctx: ResolvedProxyContext,
): Promise<Response> {
	const {
		requestId,
		method,
		path,
		account,
		requestHeaders,
		requestBody,
		response: responseRaw,
		timestamp,
		upstreamRequestStartedAt,
		responseHeadersReceivedAt,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		preExtractedModel,
		upstreamRequestIsStreaming,
	} = options;

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = classifyStreamingResponse(
		response,
		ctx.provider.isStreamingResponse?.(response) ?? false,
		upstreamRequestIsStreaming,
		requestBody,
	);

	// Send START message immediately
	const startMessage: StartMessage = {
		type: "start",
		requestId,
		accountId: account?.id || null,
		accountName: account?.name ?? null,
		method,
		path,
		upstreamPath: ctx.upstreamPath,
		timestamp,
		upstreamRequestStartedAt,
		responseHeadersReceivedAt,
		requestHeaders: requestHeadersObj,
		requestBody: requestBody
			? Buffer.from(requestBody).toString("base64")
			: null,
		responseStatus: response.status,
		responseHeaders: responseHeadersObj,
		isStream,
		providerName: ctx.providerName,
		retryAttempt,
		failoverAttempts,
	};
	ctx.usageWorker.postMessage(startMessage);

	// Emit request start event for real-time dashboard
	requestEvents.emit("event", {
		type: "start",
		id: requestId,
		timestamp,
		method,
		path,
		accountId: account?.id || null,
		accountName: account?.name ?? null,
		statusCode: response.status,
		clientSessionId: extractClientSessionIdFromHeaders(requestHeadersObj),
	});

	/*********************************************************************
	 *  STREAMING RESPONSES — observe one backpressured client stream
	 *********************************************************************/
	if (isStream && response.body) {
		const analyticsTransform = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const chunkMsg: ChunkMessage = {
					type: "chunk",
					requestId,
					data: chunk,
				};
				ctx.usageWorker.postMessage(chunkMsg);
				controller.enqueue(chunk);
			},
		});

		const sendEnd = (success: boolean, error?: unknown): void => {
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				preExtractedModel,
				success,
				...(success
					? {}
					: {
							error:
								error instanceof Error
									? error.message
									: String(error ?? "Streaming response did not complete"),
						}),
			};
			ctx.usageWorker.postMessage(endMsg);
		};
		const backgroundTask = response.body
			.pipeTo(analyticsTransform.writable)
			.then(
				() => sendEnd(isExpectedResponse(path, response)),
				(error) => sendEnd(false, error),
			);
		trackProxyBackgroundTask(backgroundTask);

		return new Response(analyticsTransform.readable, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	const backgroundTask = (async () => {
		try {
			const clone = response.clone();
			const bodyBuf = await clone.arrayBuffer();
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				responseBody:
					bodyBuf.byteLength > 0
						? Buffer.from(bodyBuf).toString("base64")
						: null,
				preExtractedModel,
				success: isExpectedResponse(path, clone),
			};
			ctx.usageWorker.postMessage(endMsg);
		} catch (err) {
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				preExtractedModel,
				success: false,
				error: (err as Error).message,
			};
			ctx.usageWorker.postMessage(endMsg);
		}
	})();
	trackProxyBackgroundTask(backgroundTask);

	// Return the sanitized response
	return response;
}
