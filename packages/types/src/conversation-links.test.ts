import { describe, expect, it } from "bun:test";
import {
	decodeBase64Utf8,
	extractClientSessionIdFromHeaders,
	extractPreviousResponseId,
	extractRequestLinkageFromPayload,
	extractResponseId,
} from "./conversation-links";

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

describe("conversation link helpers", () => {
	it("extracts previous_response_id from request bodies", () => {
		expect(
			extractPreviousResponseId(
				JSON.stringify({
					type: "response.create",
					previous_response_id: "resp_prev_123",
				}),
			),
		).toBe("resp_prev_123");
	});

	it("extracts response ids from SSE response bodies", () => {
		expect(
			extractResponseId(
				[
					"event: response.created",
					'data: {"type":"response.created","response":{"id":"resp_123"}}',
					"",
				].join("\n"),
			),
		).toBe("resp_123");
	});

	it("extracts request linkage from stored request payloads", () => {
		expect(
			extractRequestLinkageFromPayload({
				request: {
					headers: {
						"x-claude-code-session-id": "session-123",
					},
					body: encode(
						JSON.stringify({
							type: "response.create",
							previous_response_id: "resp_prev_456",
						}),
					),
				},
				response: {
					body: encode(
						[
							"event: response.created",
							'data: {"type":"response.created","response":{"id":"resp_789"}}',
							"",
						].join("\n"),
					),
				},
			}),
		).toEqual({
			previousResponseId: "resp_prev_456",
			responseId: "resp_789",
			clientSessionId: "session-123",
		});
	});

	it("extracts client session ids with ccflare header precedence", () => {
		expect(extractClientSessionIdFromHeaders(null)).toBeNull();
		expect(extractClientSessionIdFromHeaders({})).toBeNull();
		expect(
			extractClientSessionIdFromHeaders({
				"x-claude-code-session-id": "claude-session",
			}),
		).toBe("claude-session");
		expect(
			extractClientSessionIdFromHeaders({
				"x-ccflare-session-id": "ccflare-session",
			}),
		).toBe("ccflare-session");
		expect(
			extractClientSessionIdFromHeaders({
				"x-ccflare-session-id": "ccflare-session",
				"x-claude-code-session-id": "claude-session",
			}),
		).toBe("ccflare-session");
		expect(
			extractClientSessionIdFromHeaders({
				"x-ccflare-session-id": 42,
				"x-claude-code-session-id": "claude-session",
			}),
		).toBe("claude-session");
	});

	it("decodes utf-8 base64 in browser-style environments", () => {
		const encoded = encode("What’s up with you?");
		const originalBuffer = globalThis.Buffer;
		// Exercise the atob/TextDecoder path used in the browser.
		Object.defineProperty(globalThis, "Buffer", {
			value: undefined,
			configurable: true,
		});

		try {
			expect(decodeBase64Utf8(encoded)).toBe("What’s up with you?");
		} finally {
			Object.defineProperty(globalThis, "Buffer", {
				value: originalBuffer,
				configurable: true,
			});
		}
	});
});
