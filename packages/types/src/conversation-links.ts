import { isRecord } from "./guards";

export const CLAUDE_CODE_SESSION_ID_HEADER = "x-claude-code-session-id";
export const CCFLARE_SESSION_ID_HEADER = "x-ccflare-session-id";

/**
 * Session-id headers claudeflare consumes, in precedence order. ccflare's own
 * header wins over headers a client may be blindly passing through.
 */
const SESSION_ID_HEADERS = [
	CCFLARE_SESSION_ID_HEADER,
	CLAUDE_CODE_SESSION_ID_HEADER,
] as const;

export function decodeBase64Utf8(
	value: string | null | undefined,
): string | null {
	if (!value || value === "[streamed]") {
		return null;
	}

	try {
		if (typeof Buffer !== "undefined") {
			return Buffer.from(value, "base64").toString("utf8");
		}

		if (typeof atob === "function") {
			const binary = atob(value);
			const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
			return new TextDecoder("utf-8").decode(bytes);
		}
	} catch {
		// Ignore invalid base64 payloads.
	}

	return null;
}

function extractResponseIdFromRecord(
	record: Record<string, unknown>,
): string | null {
	if (typeof record.id === "string") {
		return record.id;
	}

	if (isRecord(record.response) && typeof record.response.id === "string") {
		return record.response.id;
	}

	return null;
}

export function extractPreviousResponseId(
	requestBody: string | null,
): string | null {
	if (!requestBody) {
		return null;
	}

	try {
		const parsed = JSON.parse(requestBody);
		if (!isRecord(parsed)) {
			return null;
		}

		return typeof parsed.previous_response_id === "string"
			? parsed.previous_response_id
			: null;
	} catch {
		return null;
	}
}

export function extractResponseId(responseBody: string | null): string | null {
	if (!responseBody) {
		return null;
	}

	try {
		const parsed = JSON.parse(responseBody);
		if (isRecord(parsed)) {
			return extractResponseIdFromRecord(parsed);
		}
	} catch {
		// Fall through to SSE parsing.
	}

	for (const line of responseBody.split("\n")) {
		if (!line.startsWith("data:")) {
			continue;
		}

		const dataStr = line.slice(5).trim();
		if (!dataStr || dataStr === "[DONE]") {
			continue;
		}

		try {
			const parsed = JSON.parse(dataStr);
			if (isRecord(parsed)) {
				const responseId = extractResponseIdFromRecord(parsed);
				if (responseId) {
					return responseId;
				}
			}
		} catch {
			// Ignore malformed SSE lines.
		}
	}

	return null;
}

export function extractClientSessionIdFromHeaders(
	headers: Record<string, unknown> | null | undefined,
): string | null {
	if (!headers) {
		return null;
	}

	for (const headerName of SESSION_ID_HEADERS) {
		const value = headers[headerName];
		if (typeof value === "string") {
			return value;
		}
	}
	return null;
}

export function extractRequestLinkageFromPayload(payload: unknown): {
	previousResponseId: string | null;
	responseId: string | null;
	clientSessionId: string | null;
} {
	if (!isRecord(payload)) {
		return {
			previousResponseId: null,
			responseId: null,
			clientSessionId: null,
		};
	}

	const requestBody = isRecord(payload.request)
		? decodeBase64Utf8(
				typeof payload.request.body === "string" ? payload.request.body : null,
			)
		: null;
	const responseBody = isRecord(payload.response)
		? decodeBase64Utf8(
				typeof payload.response.body === "string"
					? payload.response.body
					: null,
			)
		: null;
	const requestHeaders =
		isRecord(payload.request) && isRecord(payload.request.headers)
			? payload.request.headers
			: null;

	return {
		previousResponseId: extractPreviousResponseId(requestBody),
		responseId: extractResponseId(responseBody),
		clientSessionId: extractClientSessionIdFromHeaders(requestHeaders),
	};
}
