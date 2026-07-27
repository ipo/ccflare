import { HttpError } from "./errors";

function writeUnhandledError(error: unknown): void {
	if (typeof process === "undefined") {
		return;
	}

	const formattedError =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr?.write?.(`Unhandled error: ${formattedError}\n`);
}

/**
 * Create a JSON response with proper headers
 */
export function jsonResponse(
	data: unknown,
	status = 200,
	headers?: HeadersInit,
): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
	});
}

/**
 * Create an error response from any error type
 */
export function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) {
		const body: { error: string; details?: unknown } = {
			error: error.message,
		};
		if (error.details !== undefined) {
			body.details = error.details;
		}
		return jsonResponse(body, error.status);
	}

	if (
		error instanceof Error &&
		"statusCode" in error &&
		typeof error.statusCode === "number"
	) {
		const details =
			"context" in error && error.context !== undefined
				? { details: error.context }
				: {};
		return jsonResponse({ error: error.message, ...details }, error.statusCode);
	}

	// Handle generic errors
	const message =
		error instanceof Error ? error.message : "Internal server error";
	const status = 500;

	// In browser context, avoid logging side effects.
	// On the server, write directly to stderr because this package is shared with browser code.
	writeUnhandledError(error);

	return jsonResponse({ error: message }, status);
}

/**
 * Create a streaming newline-delimited JSON response.
 */
export function ndjsonResponse(
	stream: ReadableStream,
	headers?: HeadersInit,
): Response {
	return new Response(stream, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			...headers,
		},
	});
}

/**
 * Create a streaming response for Server-Sent Events
 */
export function sseResponse(
	stream: ReadableStream,
	headers?: HeadersInit,
): Response {
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...headers,
		},
	});
}
