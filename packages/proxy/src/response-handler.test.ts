import { describe, expect, it } from "bun:test";
import { requestEvents } from "@ccflare/core";
import type { Account } from "@ccflare/types";
import { waitForProxyBackgroundTasks } from "./background-tasks";
import type { ResolvedProxyContext } from "./handlers";
import { forwardToClient } from "./response-handler";

function createResolvedProxyContext(messages: unknown[]): ResolvedProxyContext {
	return {
		provider: {
			name: "openai",
			defaultBaseUrl: "https://api.openai.com",
			buildUrl() {
				return "https://api.openai.com/v1/responses";
			},
			prepareHeaders(headers: Headers) {
				return headers;
			},
			parseRateLimit() {
				return {
					isRateLimited: false,
					statusHeader: "allowed",
				};
			},
			extractUsage() {
				return null;
			},
			isStreamingResponse() {
				return false;
			},
		},
		providerName: "openai",
		upstreamPath: "/responses",
		strategy: {
			select(accounts: Account[]) {
				return accounts;
			},
		},
		dbOps: {
			getAvailableAccountsByProvider() {
				return [];
			},
			updateAccountRateLimitMeta() {},
			markAccountRateLimited() {},
		},
		runtime: {
			clientId: "test-client",
			retry: { attempts: 1, delayMs: 0, backoff: 1 },
			sessionDurationMs: 0,
			port: 8080,
		},
		credentialManager: {
			async getValidAccount(account: Account) {
				return account;
			},
			async refreshAfterUnauthorized(account: Account) {
				return account;
			},
		},
		asyncWriter: {
			enqueue() {},
		},
		usageWorker: {
			postMessage(message: unknown) {
				messages.push(message);
			},
		},
	} as unknown as ResolvedProxyContext;
}

describe("forwardToClient", () => {
	it("passes explicit pre-extracted models through to the worker end message", async () => {
		const messages: unknown[] = [];
		const response = await forwardToClient(
			{
				requestId: "req-1",
				method: "POST",
				path: "/v1/ccflare/openai/responses",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(
					JSON.stringify({ model: "anthropic/claude-sonnet-4" }),
				).buffer,
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				preExtractedModel: "claude-sonnet-4",
			},
			createResolvedProxyContext(messages),
		);

		expect(response.status).toBe(200);
		await waitForProxyBackgroundTasks();

		const endMessage = messages.find(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "end",
		) as { preExtractedModel?: string } | undefined;

		expect(endMessage?.preExtractedModel).toBe("claude-sonnet-4");
	});

	it("streams headerless SSE when the request enables streaming", async () => {
		const messages: unknown[] = [];
		const sseBody = [
			"event: response.completed",
			'data: {"type":"response.completed","response":{"model":"gpt-4o","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}',
			"",
		].join("\n");
		const response = await forwardToClient(
			{
				requestId: "req-headerless-sse",
				method: "POST",
				path: "/v1/codex/responses",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(
					JSON.stringify({ model: "gpt-4o", stream: true }),
				).buffer,
				response: new Response(new TextEncoder().encode(sseBody), {
					status: 200,
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			createResolvedProxyContext(messages),
		);

		expect(await response.text()).toBe(sseBody);
		await waitForProxyBackgroundTasks();

		expect(messages).toContainEqual(
			expect.objectContaining({ type: "start", isStream: true }),
		);
		const chunks = messages.filter(
			(message): message is { type: "chunk"; data: Uint8Array } =>
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "chunk" &&
				"data" in message &&
				message.data instanceof Uint8Array,
		);
		expect(
			chunks.map((message) => Buffer.from(message.data).toString()).join(""),
		).toContain('"type":"response.completed"');
		const endMessage = messages.find(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "end",
		) as { responseBody?: string } | undefined;
		expect(endMessage).toBeDefined();
		expect(endMessage).not.toHaveProperty("responseBody");
	});

	it("streams ordered chunks without cloning the response", async () => {
		const messages: unknown[] = [];
		const encoder = new TextEncoder();
		const originalClone = Response.prototype.clone;
		let response: Response;

		Response.prototype.clone = function cloneMustNotRun(): Response {
			throw new Error("streaming response was cloned");
		};
		try {
			response = await forwardToClient(
				{
					requestId: "req-stream-no-clone",
					method: "POST",
					path: "/v1/codex/responses",
					account: null,
					requestHeaders: new Headers({
						"content-type": "application/json",
					}),
					requestBody: encoder.encode(
						JSON.stringify({ model: "gpt-5", stream: true }),
					).buffer,
					response: new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode("first"));
								controller.enqueue(encoder.encode("-second"));
								controller.close();
							},
						}),
						{ status: 200 },
					),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
					upstreamRequestIsStreaming: true,
				},
				createResolvedProxyContext(messages),
			);
		} finally {
			Response.prototype.clone = originalClone;
		}

		expect(await response.text()).toBe("first-second");
		await waitForProxyBackgroundTasks();

		const lifecycleMessages = messages.filter(
			(
				message,
			): message is { type: string; data?: Uint8Array; success?: boolean } =>
				typeof message === "object" && message !== null && "type" in message,
		);
		expect(lifecycleMessages.map((message) => message.type)).toEqual([
			"start",
			"chunk",
			"chunk",
			"end",
		]);
		expect(
			lifecycleMessages
				.filter(
					(message): message is { type: "chunk"; data: Uint8Array } =>
						message.type === "chunk" && message.data instanceof Uint8Array,
				)
				.map((message) => Buffer.from(message.data).toString())
				.join(""),
		).toBe("first-second");
		expect(lifecycleMessages.at(-1)).toMatchObject({
			type: "end",
			success: true,
		});
	});

	it("finalizes a failed stream exactly once after an upstream error", async () => {
		const messages: unknown[] = [];
		const response = await forwardToClient(
			{
				requestId: "req-stream-error",
				method: "POST",
				path: "/v1/codex/responses",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(
					JSON.stringify({ model: "gpt-5", stream: true }),
				).buffer,
				response: new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(new Error("upstream stream failed"));
						},
					}),
					{ status: 200 },
				),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				upstreamRequestIsStreaming: true,
			},
			createResolvedProxyContext(messages),
		);

		await expect(response.text()).rejects.toThrow("upstream stream failed");
		await waitForProxyBackgroundTasks();

		const endMessages = messages.filter(
			(message): message is { type: "end"; success: boolean; error?: string } =>
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "end",
		);
		expect(endMessages).toEqual([
			expect.objectContaining({
				type: "end",
				success: false,
				error: "upstream stream failed",
			}),
		]);
	});

	it("finalizes a cancelled client stream exactly once", async () => {
		const messages: unknown[] = [];
		let cancelReason: unknown;
		const response = await forwardToClient(
			{
				requestId: "req-stream-cancel",
				method: "POST",
				path: "/v1/codex/responses",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(
					JSON.stringify({ model: "gpt-5", stream: true }),
				).buffer,
				response: new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("partial"));
						},
						cancel(reason) {
							cancelReason = reason;
						},
					}),
					{ status: 200 },
				),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				upstreamRequestIsStreaming: true,
			},
			createResolvedProxyContext(messages),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected a streaming response body");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			"partial",
		);

		const reason = new Error("client stopped reading");
		await reader.cancel(reason);
		await waitForProxyBackgroundTasks();

		expect(cancelReason).toBe(reason);
		const endMessages = messages.filter(
			(message): message is { type: "end"; success: boolean; error?: string } =>
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "end",
		);
		expect(endMessages).toEqual([
			expect.objectContaining({
				type: "end",
				success: false,
				error: "client stopped reading",
			}),
		]);
	});

	it("includes the account name in the worker start message and start event", async () => {
		const messages: unknown[] = [];
		const events: unknown[] = [];
		const listener = (event: unknown) => events.push(event);
		requestEvents.on("event", listener);
		try {
			const account = {
				id: "account-1",
				name: "Primary account",
			} as Account;
			const response = await forwardToClient(
				{
					requestId: "req-named",
					method: "POST",
					path: "/v1/ccflare/openai/responses",
					account,
					requestHeaders: new Headers({
						"content-type": "application/json",
					}),
					requestBody: null,
					response: new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				createResolvedProxyContext(messages),
			);

			expect(response.status).toBe(200);
			await waitForProxyBackgroundTasks();

			const startMessage = messages.find(
				(message) =>
					typeof message === "object" &&
					message !== null &&
					"type" in message &&
					message.type === "start",
			) as { accountId?: string; accountName?: string } | undefined;
			expect(startMessage?.accountId).toBe("account-1");
			expect(startMessage?.accountName).toBe("Primary account");

			const startEvent = events.find(
				(event) =>
					typeof event === "object" &&
					event !== null &&
					"type" in event &&
					event.type === "start",
			) as { accountId?: string; accountName?: string } | undefined;
			expect(startEvent?.accountId).toBe("account-1");
			expect(startEvent?.accountName).toBe("Primary account");
		} finally {
			requestEvents.off("event", listener);
		}
	});
});
