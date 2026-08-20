import { afterEach, describe, expect, it, mock } from "bun:test";
import { requestEvents } from "@ccflare/core";
import {
	AnthropicProvider,
	GrokProvider,
	type Provider,
	ProviderRegistry,
} from "@ccflare/providers";
import type { Account } from "@ccflare/types";
import { waitForProxyBackgroundTasks } from "./background-tasks";
import { handleProxy, type ProxyContext } from "./proxy";

const originalFetch = globalThis.fetch;

function createTestProvider(name: string): Provider {
	return {
		name,
		defaultBaseUrl: `https://${name}.example.com`,
		async refreshToken(_account: Account, _clientId: string) {
			throw new Error("not implemented");
		},
		buildUrl(upstreamPath: string, query: string, account?: Account): string {
			return `${account?.base_url ?? this.defaultBaseUrl}${upstreamPath}${query}`;
		},
		prepareHeaders(headers: Headers): Headers {
			return new Headers(headers);
		},
		parseRateLimit() {
			return { isRateLimited: false };
		},
		buildProxyErrorResponse({ kind, message, retryAfterSeconds }) {
			const headers = new Headers({ "content-type": "application/json" });
			if (retryAfterSeconds !== undefined) {
				headers.set("retry-after", String(retryAfterSeconds));
			}
			return new Response(JSON.stringify({ error: { message } }), {
				status: kind === "rate_limit" ? 429 : 503,
				headers,
			});
		},
		async processResponse(response: Response): Promise<Response> {
			return response;
		},
	};
}

function createProxyContext(providers: Provider[]): ProxyContext {
	return {
		providerRegistry: new ProviderRegistry(providers),
		strategy: {
			select() {
				return [];
			},
		},
		dbOps: {
			getAllAccounts() {
				return [];
			},
			getAvailableAccountsByProvider() {
				return [];
			},
			getAccountsByProvider() {
				return [];
			},
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

function createManagedAccount(id: string, name: string): Account {
	return {
		id,
		name,
		provider: "anthropic",
		auth_method: "api_key",
		base_url: null,
		api_key: `managed-${id}`,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		weight: 1,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
	};
}

function createManagedContext(
	accounts: Account[],
	messages: unknown[],
): ProxyContext {
	return {
		...createProxyContext([new AnthropicProvider()]),
		strategy: { select: (candidates: Account[]) => candidates },
		dbOps: {
			getAccountsByProvider() {
				return accounts;
			},
			getAvailableAccountsByProvider() {
				return accounts.filter(
					(account) =>
						!account.paused &&
						(account.rate_limited_until === null ||
							account.rate_limited_until < Date.now()),
				);
			},
			markAccountRateLimited(accountId: string, retryAt: number) {
				const account = accounts.find(
					(candidate) => candidate.id === accountId,
				);
				if (account) account.rate_limited_until = retryAt;
			},
			updateAccountRateLimitMeta() {},
		},
		asyncWriter: {
			enqueue(task: () => void) {
				task();
			},
		},
		usageWorker: {
			postMessage(message: unknown) {
				messages.push(message);
			},
		},
	} as unknown as ProxyContext;
}

function createManagedGrokContext(): ProxyContext {
	const account: Account = {
		...createManagedAccount("g1", "Grok"),
		provider: "grok",
		auth_method: "oauth",
		api_key: null,
		access_token: "grok-token",
		refresh_token: "grok-refresh",
		oauth_subject: "grok-user",
	};
	return {
		...createProxyContext([new GrokProvider()]),
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getAccountsByProvider: () => [account],
			getAvailableAccountsByProvider: () => [account],
			updateAccountRateLimitMeta() {},
		},
		asyncWriter: {
			enqueue(task: () => void) {
				task();
			},
		},
		usageWorker: { postMessage() {} },
	} as unknown as ProxyContext;
}

function nativeRequest(): Request {
	return new Request("http://localhost:8080/v1/anthropic/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": "caller-credential",
		},
		body: JSON.stringify({ model: "claude-test", messages: [] }),
	});
}

afterEach(() => {
	requestEvents.removeAllListeners("event");
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("handleProxy routing", () => {
	it("forwards native Grok Responses JSON and SSE without translation", async () => {
		const context = createManagedGrokContext();
		const requestBody = JSON.stringify({
			model: "grok-4.6",
			input: "hello",
			metadata: { native: true },
		});
		let upstreamCall = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				expect(request.url).toBe(
					"https://cli-chat-proxy.grok.com/v1/responses",
				);
				expect(await request.text()).toBe(requestBody);
				expect(request.headers.get("x-grok-conv-id")).toBe("caller-conv");
				upstreamCall++;
				if (upstreamCall === 1) {
					return Response.json({
						id: "response-json",
						type: "response.completed",
						native: true,
					});
				}
				return new Response(
					'data: {"type":"response.created","native":true}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		) as unknown as typeof fetch;
		const createRequest = () =>
			new Request("http://localhost:8080/v1/grok/responses", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-grok-conv-id": "caller-conv",
				},
				body: requestBody,
			});
		const url = new URL("http://localhost:8080/v1/grok/responses");
		const jsonResponse = await handleProxy(createRequest(), url, context);
		expect(jsonResponse.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await jsonResponse.json()).toEqual({
			id: "response-json",
			type: "response.completed",
			native: true,
		});

		const response = await handleProxy(
			createRequest(),
			new URL("http://localhost:8080/v1/grok/responses"),
			context,
		);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await response.text()).toBe(
			'data: {"type":"response.created","native":true}\n\n',
		);
	});

	it("rejects non-Responses Grok paths and non-POST methods before upstream access", async () => {
		const upstream = mock(async () => new Response("should not run"));
		globalThis.fetch = upstream as unknown as typeof fetch;
		const context = createManagedGrokContext();
		const credentialLookup = mock(async (account: Account) => account);
		context.credentialManager.getValidAccount = credentialLookup;
		const cases = [
			["POST", "/v1/grok/chat/completions", 404],
			["POST", "/v1/grok/models-v2", 404],
			["POST", "/v1/grok/conversations", 404],
			["POST", "/v1/grok/workspaces", 404],
			["POST", "/v1/grok/responses/", 404],
			["GET", "/v1/grok/responses", 405],
			["PUT", "/v1/grok/responses", 405],
		] as const;

		for (const [method, path, status] of cases) {
			const request = new Request(`http://localhost:8080${path}`, {
				method,
				...(method === "POST" || method === "PUT" ? { body: "{}" } : {}),
			});
			const response = await handleProxy(
				request,
				new URL(request.url),
				context,
			);
			expect(response.status).toBe(status);
			if (status === 405) expect(response.headers.get("allow")).toBe("POST");
		}
		expect(credentialLookup).not.toHaveBeenCalled();
		expect(upstream).not.toHaveBeenCalled();
	});

	it("rejects unmanaged Grok bearer or API-key passthrough", async () => {
		const upstream = mock(async () => new Response("should not run"));
		globalThis.fetch = upstream as unknown as typeof fetch;
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/grok/responses", {
				method: "POST",
				headers: { authorization: "Bearer caller-key" },
				body: "{}",
			}),
			new URL("http://localhost:8080/v1/grok/responses"),
			createProxyContext([new GrokProvider()]),
		);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("connected OAuth account");
		expect(upstream).not.toHaveBeenCalled();
	});

	it("returns 404 for an unknown provider", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/google/v1/chat", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/google/v1/chat"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("returns 404 for a bare /v1/ path", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/"),
			new URL("http://localhost:8080/v1/"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("matches providers case-sensitively", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/Anthropic/v1/messages", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/Anthropic/v1/messages"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("emits an ingress event before the upstream response is available", async () => {
		const fetchControl: { resolve?: (response: Response) => void } = {};
		const fetchPromise = new Promise<Response>((resolve) => {
			fetchControl.resolve = resolve;
		});
		const fetchMock = mock(() => fetchPromise);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const events: Array<unknown> = [];
		requestEvents.on("event", (event) => {
			events.push(event);
		});

		const responsePromise = handleProxy(
			new Request("http://localhost:8080/v1/anthropic/v1/messages", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(events).toContainEqual({
			type: "ingress",
			id: expect.any(String),
			timestamp: expect.any(Number),
			method: "POST",
			path: "/v1/anthropic/v1/messages",
			clientSessionId: null,
		});
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const resolveFetch = fetchControl.resolve;
		if (!resolveFetch) {
			throw new Error("Expected fetch resolver to be assigned");
		}
		resolveFetch(new Response("ok", { status: 200 }));
		const response = await responsePromise;

		expect(response.status).toBe(200);
	});

	it("includes the client session id in the ingress event when present", async () => {
		const fetchMock = mock(() =>
			Promise.resolve(new Response("ok", { status: 200 })),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const events: Array<unknown> = [];
		requestEvents.on("event", (event) => {
			events.push(event);
		});

		const response = await handleProxy(
			new Request("http://localhost:8080/v1/anthropic/v1/messages", {
				method: "POST",
				headers: { "x-ccflare-session-id": "session-abc-123" },
			}),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(200);
		expect(events).toContainEqual({
			type: "ingress",
			id: expect.any(String),
			timestamp: expect.any(Number),
			method: "POST",
			path: "/v1/anthropic/v1/messages",
			clientSessionId: "session-abc-123",
		});
	});

	it("retains a headerless managed 429, derives Retry-After, and persists it", async () => {
		const messages: unknown[] = [];
		const account = createManagedAccount("a1", "managed Claude");
		const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			expect(request.headers.get("x-api-key")).toBe("managed-a1");
			return Promise.resolve(
				new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await handleProxy(
			nativeRequest(),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createManagedContext([account], messages),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("60");
		expect(await response.text()).toBe(
			'{"type":"error","error":{"type":"rate_limit_error"}}',
		);
		await waitForProxyBackgroundTasks();
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "start",
				accountId: "a1",
				providerName: "anthropic",
				path: "/v1/anthropic/v1/messages",
				responseStatus: 429,
			}),
		);
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "end",
				responseBody: Buffer.from(
					'{"type":"error","error":{"type":"rate_limit_error"}}',
				).toString("base64"),
			}),
		);
	});

	it("fails over managed accounts and retains the earliest reset when all rate limit", async () => {
		const accounts = [
			createManagedAccount("a1", "first"),
			createManagedAccount("a2", "second"),
		];
		const calls: string[] = [];
		const earliest = Math.floor((Date.now() + 30_000) / 1000);
		const later = Math.floor((Date.now() + 90_000) / 1000);
		globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			calls.push(request.headers.get("x-api-key") ?? "");
			const reset = calls.length === 1 ? later : earliest;
			return Promise.resolve(
				new Response(`limited-${calls.length}`, {
					status: 429,
					headers: { "x-ratelimit-reset": String(reset) },
				}),
			);
		}) as unknown as typeof fetch;

		const response = await handleProxy(
			nativeRequest(),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createManagedContext(accounts, []),
		);
		expect(calls).toEqual(["managed-a1", "managed-a2"]);
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("limited-1");
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(
			29,
		);
		expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(30);
	});

	it("returns the later managed success after a 429", async () => {
		const accounts = [
			createManagedAccount("a1", "first"),
			createManagedAccount("a2", "second"),
		];
		const calls: string[] = [];
		globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			calls.push(request.headers.get("x-api-key") ?? "");
			return Promise.resolve(
				calls.length === 1
					? new Response("limited", { status: 429 })
					: new Response("managed success", { status: 200 }),
			);
		}) as unknown as typeof fetch;

		const response = await handleProxy(
			nativeRequest(),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createManagedContext(accounts, []),
		);
		expect(calls).toEqual(["managed-a1", "managed-a2"]);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("managed success");
	});

	it("returns a local persisted 429 during managed cooldown without upstream auth passthrough", async () => {
		const messages: unknown[] = [];
		const account = {
			...createManagedAccount("a1", "cooling"),
			rate_limited_until: Date.now() + 30_000,
		};
		const fetchMock = mock(() => Promise.resolve(new Response("unexpected")));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await handleProxy(
			nativeRequest(),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createManagedContext([account], messages),
		);
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(
			29,
		);
		expect(fetchMock).not.toHaveBeenCalled();
		await waitForProxyBackgroundTasks();
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "start",
				accountId: null,
				responseStatus: 429,
			}),
		);
	});

	it("keeps zero-account native passthrough and blocks paused managed accounts", async () => {
		const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			expect(request.headers.get("x-api-key")).toBe("caller-credential");
			return Promise.resolve(new Response("passthrough", { status: 200 }));
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const url = new URL("http://localhost:8080/v1/anthropic/v1/messages");
		const passthrough = await handleProxy(
			nativeRequest(),
			url,
			createManagedContext([], []),
		);
		expect(await passthrough.text()).toBe("passthrough");

		const paused = { ...createManagedAccount("a1", "paused"), paused: true };
		const unavailable = await handleProxy(
			nativeRequest(),
			url,
			createManagedContext([paused], []),
		);
		expect(unavailable.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
