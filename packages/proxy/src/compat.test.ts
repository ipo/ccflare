import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	AnthropicProvider,
	ClaudeCodeProvider,
	CodexProvider,
	createProviderRegistry,
	OpenAIProvider,
} from "@ccflare/providers";
import type { Account, AccountProvider } from "@ccflare/types";
import {
	createApiKeyAccount,
	createOAuthAccount,
	originalFetch,
} from "../../providers/src/test-helpers/index.ts";
import { handleCompatibilityProxy, type ProxyContext } from "./index";

function createProxyContext(
	accountsByProvider: Partial<Record<AccountProvider, Account[]>>,
): ProxyContext {
	return {
		providerRegistry: createProviderRegistry([
			new AnthropicProvider(),
			new OpenAIProvider(),
			new ClaudeCodeProvider(),
			new CodexProvider(),
		]),
		strategy: {
			select(accounts: Account[]) {
				return accounts;
			},
		},
		dbOps: {
			getAvailableAccountsByProvider(provider: AccountProvider) {
				return accountsByProvider[provider] ?? [];
			},
			updateAccountRateLimitMeta() {},
			markAccountRateLimited() {},
		},
		runtime: {
			clientId: "test-client",
			retry: {
				attempts: 1,
				delayMs: 0,
				backoff: 1,
			},
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
			postMessage() {},
		} as unknown as Worker,
	} as unknown as ProxyContext;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("handleCompatibilityProxy", () => {
	it("rejects grok-prefixed models with native Responses guidance", async () => {
		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/openai/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "grok/grok-4.6", input: "hello" }),
			}),
			new URL("http://localhost:8080/v1/ccflare/openai/responses"),
			createProxyContext({}),
		);
		if (!response) throw new Error("expected compatibility rejection");
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("POST /v1/grok/responses");
	});

	it("uses the route-native family when the model is unprefixed", async () => {
		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/openai/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "gpt-4o-mini",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
			new URL("http://localhost:8080/v1/ccflare/openai/chat/completions"),
			createProxyContext({}),
		);

		if (!response) {
			throw new Error("Expected a response");
		}

		expect(response.status).toBe(503);
	});

	it("rejects Kimi-prefixed models on every compatibility endpoint", async () => {
		for (const path of [
			"/v1/ccflare/anthropic/messages",
			"/v1/ccflare/openai/chat/completions",
			"/v1/ccflare/openai/responses",
		]) {
			const response = await handleCompatibilityProxy(
				new Request(`http://localhost:8080${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: "kimi/k3", input: "hello" }),
				}),
				new URL(`http://localhost:8080${path}`),
				createProxyContext({ kimi: [createOAuthAccount("kimi")] }),
			);

			if (!response) throw new Error("Expected a response");
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error:
					"Kimi models are not supported on compatibility routes; use POST /v1/kimi/chat/completions",
			});
		}
	});

	it("returns 503 when the requested family has no usable accounts", async () => {
		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/openai/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "openai/gpt-4o-mini",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
			new URL("http://localhost:8080/v1/ccflare/openai/chat/completions"),
			createProxyContext({}),
		);

		if (!response) {
			throw new Error("Expected a response");
		}

		expect(response.status).toBe(503);
	});

	it("prefers codex ahead of openai for the public openai family", async () => {
		const seenUrls: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				seenUrls.push(request.url);
				return new Response(
					JSON.stringify({
						id: "resp_test",
						object: "response",
						created_at: 1,
						model: "gpt-5.4",
						status: "completed",
						output: [
							{
								id: "msg_test",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "hello from codex" }],
							},
						],
						usage: {
							input_tokens: 4,
							output_tokens: 3,
							total_tokens: 7,
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/openai/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "openai/gpt-5.4",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
			new URL("http://localhost:8080/v1/ccflare/openai/chat/completions"),
			createProxyContext({
				codex: [createOAuthAccount("codex")],
				openai: [createApiKeyAccount("openai")],
			}),
		);

		if (!response) {
			throw new Error("Expected a response");
		}

		const json = (await response.json()) as {
			object: string;
			choices: Array<{ message: { content: string } }>;
		};
		expect(seenUrls).toHaveLength(1);
		expect(seenUrls[0]).toContain("chatgpt.com/backend-api/codex/responses");
		expect(json.object).toBe("chat.completion");
		expect(json.choices[0]?.message.content).toBe("hello from codex");
	});

	it("converts anthropic-family upstream JSON into OpenAI responses objects", async () => {
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						id: "msg_test",
						type: "message",
						role: "assistant",
						model: "claude-opus-4.6",
						content: [{ type: "text", text: "translated" }],
						stop_reason: "end_turn",
						stop_sequence: null,
						usage: {
							input_tokens: 10,
							output_tokens: 5,
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/openai/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "anthropic/claude-opus-4.6",
					input: "hello",
					instructions: "Keep it short.",
					metadata: { source: "compat-test" },
					tool_choice: "auto",
				}),
			}),
			new URL("http://localhost:8080/v1/ccflare/openai/responses"),
			createProxyContext({
				anthropic: [createApiKeyAccount("anthropic")],
			}),
		);

		if (!response) {
			throw new Error("Expected a response");
		}

		const json = (await response.json()) as {
			object: string;
			output: Array<{ type: string; content?: Array<{ text: string }> }>;
			instructions?: string;
			metadata?: { source?: string };
			tool_choice?: string;
		};
		expect(json.object).toBe("response");
		expect(json.output[0]?.type).toBe("message");
		expect(json.output[0]?.content?.[0]?.text).toBe("translated");
		expect(json.instructions).toBe("Keep it short.");
		expect(json.metadata?.source).toBe("compat-test");
		expect(json.tool_choice).toBe("auto");
	});

	it("preserves Lite parallel tool calls while normalizing Codex responses", async () => {
		let seenBody: Record<string, unknown> | null = null;
		let seenResponsesLiteHeader: string | null = null;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				seenBody = (await request.json()) as Record<string, unknown>;
				seenResponsesLiteHeader = request.headers.get(
					"x-openai-internal-codex-responses-lite",
				);
				return new Response(
					JSON.stringify({
						id: "resp_test",
						object: "response",
						created_at: 1,
						model: "gpt-5.4",
						status: "completed",
						output: [],
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/openai/responses", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-openai-internal-codex-responses-lite": "true",
				},
				body: JSON.stringify({
					model: "openai/gpt-5.4",
					parallel_tool_calls: false,
					input: [{ type: "message", role: "system", content: [] }],
					temperature: 0.2,
					top_p: 0.7,
					truncation: "disabled",
					user: "legacy-user",
				}),
			}),
			new URL("http://localhost:8080/v1/ccflare/openai/responses"),
			createProxyContext({
				codex: [createOAuthAccount("codex")],
			}),
		);

		if (!response) {
			throw new Error("Expected a response");
		}

		if (!seenBody) {
			throw new Error("Expected a forwarded request body");
		}
		const forwarded = seenBody as Record<string, unknown>;

		expect(forwarded.stream).toBe(true);
		expect(forwarded.store).toBe(false);
		expect(forwarded.parallel_tool_calls).toBe(false);
		expect(seenResponsesLiteHeader as string | null).toBe("true");
		expect(forwarded.include).toEqual(["reasoning.encrypted_content"]);
		expect(forwarded.truncation).toBeUndefined();
		expect(forwarded.user).toBeUndefined();
		expect(forwarded.temperature).toBeUndefined();
		expect(forwarded.top_p).toBeUndefined();
		expect(forwarded.reasoning).toEqual({
			effort: "medium",
			summary: "auto",
		});
		expect(forwarded.input).toEqual([
			{ type: "message", role: "developer", content: [] },
		]);
	});

	it("accepts the retained Anthropic compatibility path and applies Claude Code shaping", async () => {
		let seenBody: Record<string, unknown> | null = null;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				seenBody = (await request.json()) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						id: "msg_test",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4",
						content: [{ type: "text", text: "ok" }],
						stop_reason: "end_turn",
						stop_sequence: null,
						usage: {
							input_tokens: 10,
							output_tokens: 2,
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/anthropic/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "anthropic/claude-sonnet-4",
					max_tokens: 32,
					system: "Follow the repo conventions.",
					messages: [{ role: "user", content: "hi" }],
				}),
			}),
			new URL("http://localhost:8080/v1/ccflare/anthropic/messages"),
			createProxyContext({
				"claude-code": [createOAuthAccount("claude-code")],
			}),
		);

		if (!response) {
			throw new Error("Expected a response");
		}

		expect(response.status).toBe(200);
		const systemValue = (seenBody as Record<string, unknown> | null)?.system;
		const systemBlocks = Array.isArray(systemValue)
			? (systemValue as Array<{ text?: string }>)
			: [];
		expect(systemBlocks.length > 0).toBe(true);
		expect(typeof systemBlocks[0]?.text === "string").toBe(true);
		expect(
			systemBlocks[0]?.text?.startsWith("x-anthropic-billing-header:"),
		).toBe(true);
	});

	it("preserves mixed terminal outputs when codex responses are translated to chat completions", async () => {
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					[
						"event: response.completed",
						'data: {"type":"response.completed","response":{"id":"resp_1","created_at":1,"model":"gpt-5.4","output":[{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"thinking"}]},{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello"}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":"{\\"file\\":\\"README.md\\"}"}],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					},
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/openai/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "openai/gpt-5.4",
					messages: [{ role: "user", content: "hello" }],
					stream: true,
				}),
			}),
			new URL("http://localhost:8080/v1/ccflare/openai/chat/completions"),
			createProxyContext({
				codex: [createOAuthAccount("codex")],
			}),
		);

		if (!response) {
			throw new Error("Expected a response");
		}

		const text = await response.text();
		expect(text).toContain('"reasoning_content":"thinking"');
		expect(text).toContain('"content":"hello"');
		expect(text).toContain('"tool_calls"');
		expect(text).toContain('"finish_reason":"tool_calls"');
	});

	it("preserves Claude Code sentinel events as openai-compatible notices", async () => {
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					[
						"event: message_start",
						'data: {"type":"message_start","message":{"id":"msg_test","model":"claude-sonnet-4","usage":{"input_tokens":10,"output_tokens":0}}}',
						"",
						'data: {"type":"system","subtype":"session_state_changed","state":"requires_action","session_id":"sess_123"}',
						"",
						'data: {"type":"tool_progress","tool_use_id":"toolu_123","tool_name":"Bash","elapsed_time_seconds":2.5,"session_id":"sess_123"}',
						"",
						"event: message_stop",
						'data: {"type":"message_stop"}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					},
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const response = await handleCompatibilityProxy(
			new Request("http://localhost:8080/v1/ccflare/openai/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "anthropic/claude-sonnet-4",
					input: "hello",
					stream: true,
				}),
			}),
			new URL("http://localhost:8080/v1/ccflare/openai/responses"),
			createProxyContext({
				anthropic: [createApiKeyAccount("anthropic")],
			}),
		);

		if (!response) {
			throw new Error("Expected a response");
		}

		const text = await response.text();
		expect(text).toContain('"Session state changed: requires_action"');
		expect(text).toContain('"Tool progress: Bash (2.5s)"');
		expect(text).toContain('"type":"response.completed"');
	});
});
