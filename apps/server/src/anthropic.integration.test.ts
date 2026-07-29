import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory } from "@ccflare/database";
import startServer from "./server";

const SERVER_URL = "http://localhost:8080";

/** Extract accountId from a MutationResult response body */
function parseAccountId(body: string): string {
	const result = JSON.parse(body) as {
		success: boolean;
		data?: { accountId: string };
	};
	return result.data?.accountId ?? "";
}

type CurlResponse = {
	status: number;
	headers: Headers;
	body: string;
};

type AccountListResponse = Array<{
	id: string;
	name: string;
	provider?: string;
	auth_method?: string;
	requestCount: number;
	totalRequests: number;
	rateLimitStatus: {
		code: string;
		isLimited: boolean;
		until: string | null;
	};
	rateLimitReset?: string | null;
	rateLimitRemaining: number | null;
	tokenExpiresAt?: string | null;
	sessionInfo: {
		active: boolean;
		startedAt: string | null;
		requestCount: number;
	};
}>;

type RequestSummaryResponse = Array<{
	id: string;
	path: string;
	provider?: string;
	accountUsed?: string | null;
	accountName?: string | null;
	failoverAttempts?: number;
	model?: string;
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
}>;

type UpstreamRequest = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
};

let server: ReturnType<typeof startServer> | null = null;
let tempDir: string | null = null;
const originalFetch = globalThis.fetch;
const upstreamRequests: UpstreamRequest[] = [];

function parseCurlResponse(raw: string): CurlResponse {
	const normalized = raw.replaceAll("\r\n", "\n");
	const separatorIndex = normalized.indexOf("\n\n");
	const headerText =
		separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
	const body = separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : "";
	const headerLines = headerText.split("\n").filter(Boolean);
	const statusLine = headerLines.shift() ?? "";
	const status = Number(statusLine.split(" ")[1]);
	const headers = new Headers();

	for (const line of headerLines) {
		const separator = line.indexOf(":");
		if (separator < 0) continue;

		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		headers.append(key, value);
	}

	return { status, headers, body };
}

async function runCurl(args: string[]): Promise<CurlResponse> {
	return await new Promise((resolve, reject) => {
		let output = "";
		let stderr = "";
		const child = spawn("curl", ["-sS", "-i", ...args]);

		child.stdout.on("data", (chunk) => {
			output += chunk.toString("utf8");
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(stderr || `curl exited with code ${code}`));
				return;
			}

			resolve(parseCurlResponse(output));
		});
	});
}

async function runStreamingCurl(
	path: string,
	body: string,
): Promise<{
	status: number;
	headers: Headers;
	body: string;
	messageStartAt: number | null;
	contentDeltaAt: number | null;
}> {
	return await new Promise((resolve, reject) => {
		const startedAt = Date.now();
		let output = "";
		let stderr = "";
		let messageStartAt: number | null = null;
		let contentDeltaAt: number | null = null;

		const child = spawn("curl", [
			"-sS",
			"-N",
			"-i",
			"-X",
			"POST",
			`${SERVER_URL}${path}`,
			"-H",
			"content-type: application/json",
			"--data",
			body,
		]);

		child.stdout.on("data", (chunk) => {
			output += chunk.toString("utf8");

			if (
				messageStartAt === null &&
				(output.includes("event: message_start") ||
					output.includes("event: response.created"))
			) {
				messageStartAt = Date.now() - startedAt;
			}

			if (
				contentDeltaAt === null &&
				(output.includes("event: content_block_delta") ||
					output.includes("event: response.completed"))
			) {
				contentDeltaAt = Date.now() - startedAt;
			}
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(stderr || `curl exited with code ${code}`));
				return;
			}

			const response = parseCurlResponse(output);
			resolve({
				...response,
				messageStartAt,
				contentDeltaAt,
			});
		});
	});
}

async function waitFor<T>(
	getValue: () => Promise<T>,
	isReady: (value: T) => boolean,
	timeoutMs = 2_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastValue: T | null = null;

	while (Date.now() < deadline) {
		lastValue = await getValue();
		if (isReady(lastValue)) {
			return lastValue;
		}

		await Bun.sleep(25);
	}

	throw new Error(
		`Timed out waiting for expected state: ${JSON.stringify(lastValue)}`,
	);
}

async function readJson<T>(path: string): Promise<T> {
	const response = await originalFetch(`${SERVER_URL}${path}`);
	return (await response.json()) as T;
}

async function createAccount(
	body: Record<string, unknown>,
): Promise<{ accountId: string }> {
	const response = await runCurl([
		"-X",
		"POST",
		`${SERVER_URL}/api/accounts`,
		"-H",
		"content-type: application/json",
		"--data",
		JSON.stringify(body),
	]);

	expect(response.status).toBe(200);
	const result = JSON.parse(response.body) as {
		success: boolean;
		data?: { accountId: string };
	};
	return { accountId: result.data?.accountId ?? "" };
}

function updateAccountExpiry(name: string, expiresAt: number | null): void {
	const dbOps = DatabaseFactory.getInstance();
	const account = dbOps.getAccountByName(name);

	if (!account?.access_token) {
		throw new Error(
			`Expected persisted account '${name}' with an access token`,
		);
	}

	dbOps.updateAccountTokens(
		account.id,
		account.access_token,
		expiresAt,
		account.refresh_token ?? undefined,
	);
}

function readPersistedAccount(name: string): {
	access_token: string | null;
	refresh_token: string | null;
	expires_at: number | null;
} | null {
	const account = DatabaseFactory.getInstance().getAccountByName(name);
	return account
		? {
				access_token: account.access_token,
				refresh_token: account.refresh_token,
				expires_at: account.expires_at,
			}
		: null;
}

afterEach(async () => {
	await server?.stop();
	server = null;
	await Bun.sleep(150);
	globalThis.fetch = originalFetch;
	upstreamRequests.length = 0;

	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}

	delete process.env.ccflare_DB_PATH;
	delete process.env.ccflare_CONFIG_PATH;
});

describe("Anthropic passthrough integration", () => {
	it("proxies Anthropic traffic under /v1/anthropic and updates health/rate-limit state", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "ccflare-anthropic-"));
		process.env.ccflare_DB_PATH = join(tempDir, "ccflare.db");
		process.env.ccflare_CONFIG_PATH = join(tempDir, "ccflare.json");

		const mockedFetch = Object.assign(
			async (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const request = new Request(input, init);
				const url = new URL(request.url);

				if (url.origin === "https://platform.claude.com") {
					const body =
						request.method === "GET" || request.method === "HEAD"
							? null
							: await request.clone().text();

					upstreamRequests.push({
						url: request.url,
						method: request.method,
						headers: Object.fromEntries(request.headers.entries()),
						body,
					});

					return new Response(
						JSON.stringify({
							access_token: "fresh-claude-access-token",
							refresh_token: "fresh-claude-refresh-token",
							expires_in: 3600,
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
							},
						},
					);
				}

				if (url.origin === "https://api.anthropic.com") {
					const body =
						request.method === "GET" || request.method === "HEAD"
							? null
							: await request.clone().text();

					upstreamRequests.push({
						url: request.url,
						method: request.method,
						headers: Object.fromEntries(request.headers.entries()),
						body,
					});

					if (url.pathname === "/v1/models") {
						return new Response(
							JSON.stringify({
								data: [{ id: "claude-3-7-sonnet" }],
								query: Object.fromEntries(url.searchParams.entries()),
							}),
							{
								status: 200,
								headers: {
									"content-type": "application/json",
								},
							},
						);
					}

					if (url.pathname !== "/v1/messages") {
						return new Response(
							JSON.stringify({
								type: "error",
								error: { message: `Unknown path ${url.pathname}` },
							}),
							{
								status: 404,
								headers: {
									"content-type": "application/json",
								},
							},
						);
					}

					if (body === "{}") {
						return new Response(
							JSON.stringify({
								type: "error",
								error: {
									type: "invalid_request_error",
									message: "messages: required",
								},
							}),
							{
								status: 400,
								headers: {
									"content-type": "application/json",
								},
							},
						);
					}

					if (body?.includes('"stream":true')) {
						const encoder = new TextEncoder();
						const stream = new ReadableStream<Uint8Array>({
							async start(controller) {
								controller.enqueue(
									encoder.encode(
										[
											"event: message_start",
											'data: {"type":"message_start","message":{"model":"claude-3-7-sonnet","usage":{"input_tokens":3,"output_tokens":0}}}',
											"",
										].join("\n"),
									),
								);
								await Bun.sleep(250);
								controller.enqueue(
									encoder.encode(
										[
											"event: content_block_delta",
											'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
											"",
										].join("\n"),
									),
								);
								controller.close();
							},
						});

						return new Response(stream, {
							status: 200,
							headers: {
								"content-type": "text/event-stream; charset=utf-8",
								"anthropic-ratelimit-unified-status": "allowed",
								"anthropic-ratelimit-unified-reset": String(
									Math.floor((Date.now() + 120_000) / 1000),
								),
								"anthropic-ratelimit-unified-remaining": "16",
							},
						});
					}

					if (request.headers.has("authorization")) {
						return new Response(
							JSON.stringify({
								id: "msg_claude_code",
								type: "message",
								provider: "claude-code",
								model: "claude-3-7-sonnet",
								usage: {
									input_tokens: 9,
									output_tokens: 3,
								},
							}),
							{
								status: 200,
								headers: {
									"content-type": "application/json",
									"anthropic-ratelimit-unified-status": "allowed",
									"anthropic-ratelimit-unified-reset": String(
										Math.floor((Date.now() + 120_000) / 1000),
									),
									"anthropic-ratelimit-unified-remaining": "15",
								},
							},
						);
					}

					return new Response(
						JSON.stringify({
							id: "msg_test",
							type: "message",
							model: "claude-3-7-sonnet",
							usage: {
								input_tokens: 3,
								output_tokens: 2,
							},
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								"anthropic-ratelimit-unified-status": "allowed",
								"anthropic-ratelimit-unified-reset": String(
									Math.floor((Date.now() + 120_000) / 1000),
								),
								"anthropic-ratelimit-unified-remaining": "17",
							},
						},
					);
				}

				if (url.origin === "https://auth.openai.com") {
					const body =
						request.method === "GET" || request.method === "HEAD"
							? null
							: await request.clone().text();

					upstreamRequests.push({
						url: request.url,
						method: request.method,
						headers: Object.fromEntries(request.headers.entries()),
						body,
					});

					return new Response(
						JSON.stringify({
							access_token: "fresh-access-token",
							refresh_token: "fresh-refresh-token",
							expires_in: 3600,
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
							},
						},
					);
				}

				if (url.origin === "https://chatgpt.com") {
					const body =
						request.method === "GET" || request.method === "HEAD"
							? null
							: await request.clone().text();

					upstreamRequests.push({
						url: request.url,
						method: request.method,
						headers: Object.fromEntries(request.headers.entries()),
						body,
					});

					if (url.pathname !== "/backend-api/codex/responses") {
						return new Response(
							JSON.stringify({
								error: {
									message: `Unknown path ${url.pathname}`,
								},
							}),
							{
								status: 404,
								headers: {
									"content-type": "application/json",
								},
							},
						);
					}

					const fiveHourReset = Math.floor((Date.now() + 300_000) / 1000);
					const sevenDayReset = Math.floor((Date.now() + 604_800_000) / 1000);

					if (body?.includes('"stream":true')) {
						const encoder = new TextEncoder();
						const stream = new ReadableStream<Uint8Array>({
							async start(controller) {
								controller.enqueue(
									encoder.encode(
										[
											"event: response.created",
											'data: {"type":"response.created","response":{"id":"resp_codex","model":"gpt-5-codex"}}',
											"",
										].join("\n"),
									),
								);
								await Bun.sleep(220);
								controller.enqueue(
									encoder.encode(
										[
											"event: response.completed",
											'data: {"type":"response.completed","response":{"id":"resp_codex","model":"gpt-5-codex","usage":{"input_tokens":21,"output_tokens":8,"total_tokens":29}}}',
											"",
										].join("\n"),
									),
								);
								controller.close();
							},
						});

						return new Response(stream, {
							status: 200,
							headers: {
								"content-type": "text/event-stream; charset=utf-8",
								"x-codex-5h-reset-at": String(fiveHourReset),
								"x-codex-7d-reset-at": String(sevenDayReset),
							},
						});
					}

					return new Response(
						JSON.stringify({
							id: "resp_codex_json",
							object: "response",
							model: "gpt-5-codex",
							output: [{ type: "message", content: [{ type: "output_text" }] }],
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								"x-codex-5h-reset-at": String(fiveHourReset),
								"x-codex-7d-reset-at": String(sevenDayReset),
							},
						},
					);
				}

				if (url.origin === "https://api.openai.com") {
					const body =
						request.method === "GET" || request.method === "HEAD"
							? null
							: await request.clone().text();

					upstreamRequests.push({
						url: request.url,
						method: request.method,
						headers: Object.fromEntries(request.headers.entries()),
						body,
					});

					if (url.pathname === "/v1/models") {
						return new Response(
							JSON.stringify({
								data: [{ id: "gpt-4o-mini" }],
								query: Object.fromEntries(url.searchParams.entries()),
							}),
							{
								status: 200,
								headers: {
									"content-type": "application/json",
								},
							},
						);
					}

					if (url.pathname === "/v1/chat/completions") {
						const authorization = request.headers.get("authorization");

						if (authorization === "Bearer sk-openai-fail-primary") {
							return new Response(
								JSON.stringify({ error: { message: "rate limited" } }),
								{
									status: 429,
									headers: {
										"content-type": "application/json",
									},
								},
							);
						}

						if (authorization === "Bearer sk-openai-fail-secondary") {
							return new Response(
								JSON.stringify({
									id: "chatcmpl_secondary",
									object: "chat.completion",
									model: "gpt-4o-mini",
									choices: [
										{
											index: 0,
											message: {
												role: "assistant",
												content: "secondary success",
											},
										},
									],
									usage: {
										prompt_tokens: 8,
										completion_tokens: 4,
										total_tokens: 12,
									},
								}),
								{
									status: 200,
									headers: {
										"content-type": "application/json",
									},
								},
							);
						}

						if (
							authorization === "Bearer sk-openai-exhaust-primary" ||
							authorization === "Bearer sk-openai-exhaust-secondary"
						) {
							return new Response(
								JSON.stringify({ error: { message: "rate limited" } }),
								{
									status: 429,
									headers: {
										"content-type": "application/json",
									},
								},
							);
						}

						if (authorization === "Bearer fresh-access-token") {
							return new Response(
								JSON.stringify({
									id: "chatcmpl_refreshed",
									object: "chat.completion",
									model: "gpt-4o-mini",
									choices: [
										{
											index: 0,
											message: {
												role: "assistant",
												content: "fresh token used",
											},
										},
									],
									usage: {
										prompt_tokens: 5,
										completion_tokens: 2,
										total_tokens: 7,
									},
								}),
								{
									status: 200,
									headers: {
										"content-type": "application/json",
									},
								},
							);
						}

						return new Response(
							JSON.stringify({
								id: "chatcmpl_test",
								object: "chat.completion",
								model: "gpt-4o-mini",
								choices: [
									{
										index: 0,
										message: {
											role: "assistant",
											content: "hello from openai",
										},
									},
								],
								usage: {
									prompt_tokens: 11,
									completion_tokens: 7,
									total_tokens: 18,
								},
							}),
							{
								status: 200,
								headers: {
									"content-type": "application/json",
									"x-ratelimit-limit-requests": "100",
									"x-ratelimit-remaining-requests": "17",
									"x-ratelimit-reset-requests": String(
										Math.floor((Date.now() + 120_000) / 1000),
									),
								},
							},
						);
					}

					if (url.pathname === "/v1/responses") {
						const encoder = new TextEncoder();
						const stream = new ReadableStream<Uint8Array>({
							async start(controller) {
								controller.enqueue(
									encoder.encode(
										[
											"event: response.created",
											'data: {"response":{"id":"resp_123","model":"gpt-4o"}}',
											"",
										].join("\n"),
									),
								);
								await Bun.sleep(250);
								controller.enqueue(
									encoder.encode(
										[
											"event: response.completed",
											'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}',
											"",
										].join("\n"),
									),
								);
								controller.close();
							},
						});

						return new Response(stream, {
							status: 200,
							headers: {
								"content-type": "text/event-stream; charset=utf-8",
								"x-codex-primary-used-percent": "12",
								"x-codex-primary-window-minutes": "10080",
								"x-codex-primary-reset-at": String(
									Math.floor((Date.now() + 120_000) / 1000),
								),
								"x-codex-secondary-used-percent": "4",
								"x-codex-secondary-window-minutes": "300",
								"x-codex-secondary-reset-at": String(
									Math.floor((Date.now() + 60_000) / 1000),
								),
							},
						});
					}

					return new Response(
						JSON.stringify({
							error: {
								message: `Unknown path ${url.pathname}`,
							},
						}),
						{
							status: 404,
							headers: {
								"content-type": "application/json",
							},
						},
					);
				}

				return originalFetch(input, init);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		globalThis.fetch = mockedFetch;

		server = startServer({ port: 8080, withDashboard: false });

		await waitFor(
			async () => (await originalFetch(`${SERVER_URL}/health`)).status,
			(status) => status === 200,
		);

		const initialHealth = await readJson<{ accounts: number }>("/health");
		expect(initialHealth.accounts).toBe(0);

		const supportedProviders = await readJson<{ providers: string[] }>(
			"/health",
		);
		expect(supportedProviders.providers).toEqual([
			"anthropic",
			"openai",
			"claude-code",
			"codex",
			"kimi",
		]);

		const createAccountResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/api/accounts`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				name: "anthropic-api-key",
				provider: "anthropic",
				auth_method: "api_key",
				api_key: "sk-ant-test",
			}),
		]);

		expect(createAccountResponse.status).toBe(200);

		const createdAccountId = parseAccountId(createAccountResponse.body);
		expect(createdAccountId).toBeTruthy();

		const healthAfterCreate = await readJson<{ accounts: number }>("/health");
		expect(healthAfterCreate.accounts).toBe(1);

		const requestBody = JSON.stringify({
			model: "claude-3-7-sonnet",
			max_tokens: 32,
			messages: [{ role: "user", content: "hello" }],
		});
		const nonStreamingResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/v1/anthropic/v1/messages`,
			"-H",
			"content-type: application/json",
			"--data",
			requestBody,
		]);

		expect(nonStreamingResponse.status).toBe(200);
		expect(nonStreamingResponse.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(JSON.parse(nonStreamingResponse.body)).toMatchObject({
			id: "msg_test",
			type: "message",
		});

		const nonStreamingUpstreamRequest = upstreamRequests.at(-1);
		expect(nonStreamingUpstreamRequest).toBeDefined();
		expect(nonStreamingUpstreamRequest?.url).toBe(
			"https://api.anthropic.com/v1/messages",
		);
		expect(nonStreamingUpstreamRequest?.headers["x-api-key"]).toBe(
			"sk-ant-test",
		);
		expect(nonStreamingUpstreamRequest?.headers.authorization).toBeUndefined();
		expect(nonStreamingUpstreamRequest?.body).toBe(requestBody);

		const updatedAccounts = await waitFor(
			() => readJson<AccountListResponse>("/api/accounts"),
			(accounts) =>
				accounts[0]?.requestCount === 1 &&
				accounts[0]?.totalRequests === 1 &&
				accounts[0]?.sessionInfo.requestCount === 1 &&
				accounts[0]?.rateLimitRemaining === 17,
		);
		expect(updatedAccounts[0]).toMatchObject({
			requestCount: 1,
			totalRequests: 1,
			rateLimitRemaining: 17,
			sessionInfo: {
				requestCount: 1,
			},
		});
		expect(updatedAccounts[0]?.rateLimitStatus.code).toContain("allowed");

		const modelsResponse = await runCurl([
			`${SERVER_URL}/v1/anthropic/v1/models?foo=bar&baz=qux`,
		]);
		expect(modelsResponse.status).toBe(200);
		expect(JSON.parse(modelsResponse.body)).toMatchObject({
			query: {
				foo: "bar",
				baz: "qux",
			},
		});
		expect(upstreamRequests.at(-1)?.url).toBe(
			"https://api.anthropic.com/v1/models?foo=bar&baz=qux",
		);

		const errorResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/v1/anthropic/v1/messages`,
			"-H",
			"content-type: application/json",
			"--data",
			"{}",
		]);
		expect(errorResponse.status).toBe(400);
		expect(errorResponse.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(JSON.parse(errorResponse.body)).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "messages: required",
			},
		});

		const streamingResponse = await runStreamingCurl(
			"/v1/anthropic/v1/messages",
			JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 32,
				stream: true,
				messages: [{ role: "user", content: "stream hello" }],
			}),
		);
		expect(streamingResponse.status).toBe(200);
		expect(streamingResponse.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		expect(streamingResponse.body).toContain("event: message_start");
		expect(streamingResponse.body).toContain("event: content_block_delta");
		expect(streamingResponse.messageStartAt).not.toBeNull();
		expect(streamingResponse.contentDeltaAt).not.toBeNull();
		expect(streamingResponse.messageStartAt as number).toBeLessThan(150);
		expect(streamingResponse.contentDeltaAt as number).toBeGreaterThan(200);

		const createOpenAIAccountResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/api/accounts`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				name: "openai-api-key",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-test",
			}),
		]);
		expect(createOpenAIAccountResponse.status).toBe(200);

		const createdOpenAIAccountId = parseAccountId(
			createOpenAIAccountResponse.body,
		);
		expect(createdOpenAIAccountId).toBeTruthy();

		const pauseAccount = async (accountId: string) => {
			const response = await runCurl([
				"-X",
				"POST",
				`${SERVER_URL}/api/accounts/${accountId}/pause`,
			]);
			expect(response.status).toBe(200);
		};

		const openAIChatRequestBody = JSON.stringify({
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: "hello" }],
		});
		const openAIChatResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/v1/openai/chat/completions`,
			"-H",
			"content-type: application/json",
			"--data",
			openAIChatRequestBody,
		]);

		expect(openAIChatResponse.status).toBe(200);
		expect(openAIChatResponse.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(JSON.parse(openAIChatResponse.body)).toMatchObject({
			id: "chatcmpl_test",
			model: "gpt-4o-mini",
		});
		expect(upstreamRequests.at(-1)?.url).toBe(
			"https://api.openai.com/v1/chat/completions",
		);
		expect(upstreamRequests.at(-1)?.headers.authorization).toBe(
			"Bearer sk-openai-test",
		);
		expect(upstreamRequests.at(-1)?.body).toBe(openAIChatRequestBody);

		const [concurrentAnthropicResponse, concurrentOpenAIResponse] =
			await Promise.all([
				runCurl([
					"-X",
					"POST",
					`${SERVER_URL}/v1/anthropic/v1/messages`,
					"-H",
					"content-type: application/json",
					"--data",
					requestBody,
				]),
				runCurl([
					"-X",
					"POST",
					`${SERVER_URL}/v1/openai/chat/completions`,
					"-H",
					"content-type: application/json",
					"--data",
					openAIChatRequestBody,
				]),
			]);
		expect(concurrentAnthropicResponse.status).toBe(200);
		expect(concurrentOpenAIResponse.status).toBe(200);

		const openAIAccountsAfterChat = await waitFor(
			() => readJson<AccountListResponse>("/api/accounts"),
			(accounts) =>
				accounts.some(
					(account) =>
						account.name === "openai-api-key" &&
						account.rateLimitRemaining === 17,
				),
		);
		expect(
			openAIAccountsAfterChat.find(
				(account) => account.name === "openai-api-key",
			),
		).toMatchObject({
			name: "openai-api-key",
			rateLimitRemaining: 17,
		});
		expect(
			openAIAccountsAfterChat.find(
				(account) => account.name === "openai-api-key",
			)?.rateLimitStatus,
		).toMatchObject({
			code: expect.stringContaining("allowed"),
		});

		const openAIJsonUsage = await waitFor(
			() => readJson<RequestSummaryResponse>("/api/requests?limit=10"),
			(requests) =>
				requests.some(
					(request) =>
						request.path === "/v1/openai/chat/completions" &&
						request.promptTokens === 11 &&
						request.completionTokens === 7 &&
						request.totalTokens === 18,
				),
		);
		expect(
			openAIJsonUsage.find(
				(request) =>
					request.path === "/v1/openai/chat/completions" &&
					request.accountName === "openai-api-key" &&
					request.promptTokens === 11,
			),
		).toMatchObject({
			provider: "openai",
			accountUsed: createdOpenAIAccountId,
			accountName: "openai-api-key",
			model: "gpt-4o-mini",
			promptTokens: 11,
			completionTokens: 7,
			totalTokens: 18,
		});
		expect(
			openAIJsonUsage.find(
				(request) =>
					request.path === "/v1/anthropic/v1/messages" &&
					request.accountName === "anthropic-api-key",
			),
		).toMatchObject({
			provider: "anthropic",
			accountUsed: createdAccountId,
			accountName: "anthropic-api-key",
		});

		const openAIResponsesStream = await runStreamingCurl(
			"/v1/openai/responses",
			JSON.stringify({
				model: "gpt-4o",
				stream: true,
				input: "stream hello",
			}),
		);
		expect(openAIResponsesStream.status).toBe(200);
		expect(openAIResponsesStream.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		expect(openAIResponsesStream.body).toContain("event: response.created");
		expect(openAIResponsesStream.body).toContain("event: response.completed");
		expect(openAIResponsesStream.messageStartAt).not.toBeNull();
		expect(openAIResponsesStream.contentDeltaAt).not.toBeNull();
		expect(openAIResponsesStream.messageStartAt as number).toBeLessThan(150);
		expect(openAIResponsesStream.contentDeltaAt as number).toBeGreaterThan(200);
		expect(upstreamRequests.at(-1)?.url).toBe(
			"https://api.openai.com/v1/responses",
		);
		expect(upstreamRequests.at(-1)?.headers.authorization).toBe(
			"Bearer sk-openai-test",
		);

		const openAISseUsage = await waitFor(
			() => readJson<RequestSummaryResponse>("/api/requests?limit=10"),
			(requests) =>
				requests.some(
					(request) =>
						request.path === "/v1/openai/responses" &&
						request.promptTokens === 13 &&
						request.completionTokens === 5 &&
						request.totalTokens === 18,
				),
		);
		expect(
			openAISseUsage.find((request) => request.path === "/v1/openai/responses"),
		).toMatchObject({
			model: "gpt-4o",
			promptTokens: 13,
			completionTokens: 5,
			totalTokens: 18,
			inputTokens: 13,
			outputTokens: 5,
		});

		const openAIModelsResponse = await runCurl([
			`${SERVER_URL}/v1/openai/models?foo=bar`,
		]);
		expect(openAIModelsResponse.status).toBe(200);
		expect(JSON.parse(openAIModelsResponse.body)).toMatchObject({
			query: {
				foo: "bar",
			},
		});
		expect(upstreamRequests.at(-1)?.url).toBe(
			"https://api.openai.com/v1/models?foo=bar",
		);

		const createdClaudeAccount = await createAccount({
			name: "claude-code-oauth",
			provider: "claude-code",
			auth_method: "oauth",
			access_token: "stale-claude-access-token",
			refresh_token: "claude-refresh-token",
		});
		const createdCodexAccount = await createAccount({
			name: "codex-oauth",
			provider: "codex",
			auth_method: "oauth",
			access_token: "codex-access-token",
			refresh_token: "codex-refresh-token",
		});
		updateAccountExpiry("codex-oauth", Date.now() + 60_000);

		const claudeCodeResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/v1/claude-code/v1/messages`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 32,
				messages: [{ role: "user", content: "refresh claude code" }],
			}),
		]);
		expect(claudeCodeResponse.status).toBe(200);
		expect(JSON.parse(claudeCodeResponse.body)).toMatchObject({
			id: "msg_claude_code",
			provider: "claude-code",
		});

		const refreshRequests = upstreamRequests.filter(
			(request) => request.url === "https://platform.claude.com/v1/oauth/token",
		);
		expect(refreshRequests).toHaveLength(1);
		expect(refreshRequests[0]?.body).toContain('"grant_type":"refresh_token"');
		expect(refreshRequests[0]?.body).toContain(
			'"refresh_token":"claude-refresh-token"',
		);
		expect(refreshRequests[0]?.body).toContain(
			'"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"',
		);

		const claudeUpstreamRequest = upstreamRequests.find(
			(request) =>
				request.url === "https://api.anthropic.com/v1/messages" &&
				request.headers.authorization === "Bearer fresh-claude-access-token",
		);
		expect(claudeUpstreamRequest).toBeDefined();
		expect(claudeUpstreamRequest?.headers["x-api-key"]).toBeUndefined();

		const persistedClaudeAccount = await waitFor(
			async () => readPersistedAccount("claude-code-oauth"),
			(account) => account?.access_token === "fresh-claude-access-token",
		);
		expect(persistedClaudeAccount).toMatchObject({
			access_token: "fresh-claude-access-token",
			refresh_token: "fresh-claude-refresh-token",
		});
		expect((persistedClaudeAccount?.expires_at ?? 0) > Date.now()).toBe(true);

		const codexStream = await runStreamingCurl(
			"/v1/codex/responses",
			JSON.stringify({
				model: "gpt-5-codex",
				stream: true,
				input: "stream codex output",
			}),
		);
		expect(codexStream.status).toBe(200);
		expect(codexStream.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		expect(codexStream.messageStartAt).not.toBeNull();
		expect(codexStream.contentDeltaAt).not.toBeNull();
		expect(codexStream.messageStartAt as number).toBeLessThan(150);
		expect(codexStream.contentDeltaAt as number).toBeGreaterThan(200);
		expect(codexStream.body.replaceAll("\r\n", "\n")).toContain(
			"event: response.created",
		);
		expect(codexStream.body.replaceAll("\r\n", "\n")).toContain(
			'data: {"type":"response.created","response":{"id":"resp_codex","model":"gpt-5-codex"}}',
		);
		expect(codexStream.body.replaceAll("\r\n", "\n")).toContain(
			"event: response.completed",
		);
		expect(codexStream.body.replaceAll("\r\n", "\n")).toContain(
			'data: {"type":"response.completed","response":{"id":"resp_codex","model":"gpt-5-codex","usage":{"input_tokens":21,"output_tokens":8,"total_tokens":29}}}',
		);

		const codexUpstreamRequest = upstreamRequests.find(
			(request) =>
				request.url === "https://chatgpt.com/backend-api/codex/responses" &&
				request.headers.authorization === "Bearer codex-access-token",
		);
		expect(codexUpstreamRequest).toBeDefined();
		expect(codexUpstreamRequest?.headers.originator).toBe("codex_cli_rs");
		expect(codexUpstreamRequest?.headers["user-agent"]).toContain(
			"codex_cli_rs/",
		);
		const fiveHourResetAt = codexStream.headers.get("x-codex-5h-reset-at");
		expect(fiveHourResetAt).not.toBeNull();

		const accountsAfterProviderSplit = await waitFor(
			() => readJson<AccountListResponse>("/api/accounts"),
			(accounts) =>
				accounts.some((account) => account.name === "codex-oauth") &&
				accounts.some((account) => account.name === "claude-code-oauth"),
		);
		expect(
			accountsAfterProviderSplit.find(
				(account) => account.name === "codex-oauth",
			),
		).toMatchObject({
			name: "codex-oauth",
			rateLimitStatus: {
				code: expect.stringContaining("allowed"),
				isLimited: false,
				until: null,
			},
			rateLimitReset: new Date(Number(fiveHourResetAt) * 1000).toISOString(),
			rateLimitRemaining: null,
		});

		const providerSplitHistory = await waitFor(
			() => readJson<RequestSummaryResponse>("/api/requests?limit=20"),
			(requests) =>
				requests.some(
					(request) =>
						request.path === "/v1/claude-code/v1/messages" &&
						request.provider === "claude-code" &&
						request.accountName === "claude-code-oauth",
				) &&
				requests.some(
					(request) =>
						request.path === "/v1/codex/responses" &&
						request.provider === "codex" &&
						request.accountName === "codex-oauth" &&
						request.promptTokens === 21 &&
						request.completionTokens === 8 &&
						request.totalTokens === 29,
				),
		);
		expect(
			providerSplitHistory.find(
				(request) => request.path === "/v1/claude-code/v1/messages",
			),
		).toMatchObject({
			provider: "claude-code",
			accountName: "claude-code-oauth",
			accountUsed: expect.any(String),
		});
		expect(
			providerSplitHistory.find(
				(request) => request.path === "/v1/codex/responses",
			),
		).toMatchObject({
			provider: "codex",
			accountName: "codex-oauth",
			accountUsed: expect.any(String),
			promptTokens: 21,
			completionTokens: 8,
			totalTokens: 29,
		});

		const fourProviderStart = upstreamRequests.length;
		const [
			fourProviderAnthropicResponse,
			fourProviderOpenAIResponse,
			fourProviderClaudeResponse,
			fourProviderCodexResponse,
		] = await Promise.all([
			runCurl([
				"-X",
				"POST",
				`${SERVER_URL}/v1/anthropic/v1/messages`,
				"-H",
				"content-type: application/json",
				"--data",
				requestBody,
			]),
			runCurl([
				"-X",
				"POST",
				`${SERVER_URL}/v1/openai/chat/completions`,
				"-H",
				"content-type: application/json",
				"--data",
				openAIChatRequestBody,
			]),
			runCurl([
				"-X",
				"POST",
				`${SERVER_URL}/v1/claude-code/v1/messages`,
				"-H",
				"content-type: application/json",
				"--data",
				JSON.stringify({
					model: "claude-3-7-sonnet",
					max_tokens: 32,
					messages: [{ role: "user", content: "claude concurrent" }],
				}),
			]),
			runCurl([
				"-X",
				"POST",
				`${SERVER_URL}/v1/codex/responses`,
				"-H",
				"content-type: application/json",
				"--data",
				JSON.stringify({
					model: "gpt-5-codex",
					input: "codex concurrent",
				}),
			]),
		]);
		expect(fourProviderAnthropicResponse.status).toBe(200);
		expect(fourProviderOpenAIResponse.status).toBe(200);
		expect(fourProviderClaudeResponse.status).toBe(200);
		expect(fourProviderCodexResponse.status).toBe(200);

		const concurrentProviderRequests =
			upstreamRequests.slice(fourProviderStart);
		expect(concurrentProviderRequests).toHaveLength(4);
		expect(
			concurrentProviderRequests.find(
				(request) =>
					request.url === "https://api.anthropic.com/v1/messages" &&
					request.headers["x-api-key"] === "sk-ant-test",
			),
		).toBeDefined();
		expect(
			concurrentProviderRequests.find(
				(request) =>
					request.url === "https://api.openai.com/v1/chat/completions" &&
					request.headers.authorization === "Bearer sk-openai-test",
			),
		).toBeDefined();
		expect(
			concurrentProviderRequests.find(
				(request) =>
					request.url === "https://api.anthropic.com/v1/messages" &&
					request.headers.authorization === "Bearer fresh-claude-access-token",
			),
		).toBeDefined();
		expect(
			concurrentProviderRequests.find(
				(request) =>
					request.url === "https://chatgpt.com/backend-api/codex/responses" &&
					request.headers.authorization === "Bearer codex-access-token",
			),
		).toBeDefined();

		const fourProviderHistory = await waitFor(
			() => readJson<RequestSummaryResponse>("/api/requests?limit=30"),
			(requests) =>
				requests.some(
					(request) =>
						request.path === "/v1/anthropic/v1/messages" &&
						request.accountName === "anthropic-api-key",
				) &&
				requests.some(
					(request) =>
						request.path === "/v1/openai/chat/completions" &&
						request.accountName === "openai-api-key",
				) &&
				requests.some(
					(request) =>
						request.path === "/v1/claude-code/v1/messages" &&
						request.accountName === "claude-code-oauth",
				) &&
				requests.some(
					(request) =>
						request.path === "/v1/codex/responses" &&
						request.accountName === "codex-oauth",
				),
		);
		expect(
			fourProviderHistory.find(
				(request) => request.path === "/v1/claude-code/v1/messages",
			),
		).toMatchObject({
			provider: "claude-code",
			accountName: "claude-code-oauth",
			accountUsed: expect.any(String),
		});
		expect(
			fourProviderHistory.find(
				(request) => request.path === "/v1/codex/responses",
			),
		).toMatchObject({
			provider: "codex",
			accountName: "codex-oauth",
			accountUsed: expect.any(String),
		});

		await pauseAccount(createdOpenAIAccountId);

		const createFailPrimaryResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/api/accounts`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				name: "openai-fail-primary",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-fail-primary",
			}),
		]);
		expect(createFailPrimaryResponse.status).toBe(200);
		const failPrimaryAccountId = parseAccountId(createFailPrimaryResponse.body);

		const createFailPausedResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/api/accounts`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				name: "openai-fail-paused",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-fail-paused",
			}),
		]);
		expect(createFailPausedResponse.status).toBe(200);
		const failPausedAccountId = parseAccountId(createFailPausedResponse.body);

		const createFailSecondaryResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/api/accounts`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				name: "openai-fail-secondary",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-fail-secondary",
			}),
		]);
		expect(createFailSecondaryResponse.status).toBe(200);
		const failSecondaryAccountId = parseAccountId(
			createFailSecondaryResponse.body,
		);

		await pauseAccount(failPausedAccountId);

		const failoverStart = upstreamRequests.length;
		const failoverResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/v1/openai/chat/completions`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				model: "gpt-4o-mini",
				messages: [{ role: "user", content: "hello failover" }],
			}),
		]);
		expect(failoverResponse.status).toBe(200);
		expect(JSON.parse(failoverResponse.body)).toMatchObject({
			id: "chatcmpl_secondary",
		});

		const failoverRequests = upstreamRequests.slice(failoverStart);
		expect(
			failoverRequests.map((request) => request.headers.authorization),
		).toEqual([
			"Bearer sk-openai-fail-primary",
			"Bearer sk-openai-fail-secondary",
		]);
		expect(
			failoverRequests.some(
				(request) =>
					request.headers.authorization === "Bearer sk-openai-fail-paused",
			),
		).toBe(false);

		const failoverHistory = await waitFor(
			() => readJson<RequestSummaryResponse>("/api/requests?limit=20"),
			(requests) =>
				requests.some(
					(request) =>
						request.accountName === "openai-fail-secondary" &&
						request.failoverAttempts === 1,
				),
		);
		expect(
			failoverHistory.find(
				(request) => request.accountName === "openai-fail-secondary",
			),
		).toMatchObject({
			provider: "openai",
			accountName: "openai-fail-secondary",
			accountUsed: failSecondaryAccountId,
			failoverAttempts: 1,
		});

		await pauseAccount(failPrimaryAccountId);
		await pauseAccount(failSecondaryAccountId);

		const createExhaustPrimaryResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/api/accounts`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				name: "openai-exhaust-primary",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-exhaust-primary",
			}),
		]);
		expect(createExhaustPrimaryResponse.status).toBe(200);
		const exhaustPrimaryAccountId = parseAccountId(
			createExhaustPrimaryResponse.body,
		);

		const createExhaustPausedResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/api/accounts`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				name: "openai-exhaust-paused",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-exhaust-paused",
			}),
		]);
		expect(createExhaustPausedResponse.status).toBe(200);
		const exhaustPausedAccountId = parseAccountId(
			createExhaustPausedResponse.body,
		);

		const createExhaustSecondaryResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/api/accounts`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				name: "openai-exhaust-secondary",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-exhaust-secondary",
			}),
		]);
		expect(createExhaustSecondaryResponse.status).toBe(200);
		const exhaustSecondaryAccountId = parseAccountId(
			createExhaustSecondaryResponse.body,
		);

		await pauseAccount(exhaustPausedAccountId);

		const exhaustedStart = upstreamRequests.length;
		const exhaustedResponse = await runCurl([
			"-X",
			"POST",
			`${SERVER_URL}/v1/openai/chat/completions`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				model: "gpt-4o-mini",
				messages: [{ role: "user", content: "all exhausted" }],
			}),
		]);
		expect(exhaustedResponse.status).toBe(503);
		expect(JSON.parse(exhaustedResponse.body)).toMatchObject({
			error: expect.stringContaining("All accounts failed"),
		});

		const exhaustedRequests = upstreamRequests.slice(exhaustedStart);
		expect(
			exhaustedRequests.map((request) => request.headers.authorization),
		).toEqual([
			"Bearer sk-openai-exhaust-primary",
			"Bearer sk-openai-exhaust-secondary",
		]);
		expect(
			exhaustedRequests.some(
				(request) =>
					request.headers.authorization === "Bearer sk-openai-exhaust-paused",
			),
		).toBe(false);

		await pauseAccount(exhaustPrimaryAccountId);
		await pauseAccount(exhaustSecondaryAccountId);

		const deleteResponse = await runCurl([
			"-X",
			"DELETE",
			`${SERVER_URL}/api/accounts/${createdAccountId}`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				confirm: "anthropic-api-key",
			}),
		]);
		expect(deleteResponse.status).toBe(200);

		const deleteOpenAIResponse = await runCurl([
			"-X",
			"DELETE",
			`${SERVER_URL}/api/accounts/${createdOpenAIAccountId}`,
			"-H",
			"content-type: application/json",
			"--data",
			JSON.stringify({
				confirm: "openai-api-key",
			}),
		]);
		expect(deleteOpenAIResponse.status).toBe(200);

		for (const accountId of [
			createdClaudeAccount.accountId,
			createdCodexAccount.accountId,
			failPrimaryAccountId,
			failPausedAccountId,
			failSecondaryAccountId,
			exhaustPrimaryAccountId,
			exhaustPausedAccountId,
			exhaustSecondaryAccountId,
		]) {
			const deleteExtraAccountResponse = await runCurl([
				"-X",
				"DELETE",
				`${SERVER_URL}/api/accounts/${accountId}`,
			]);
			expect(deleteExtraAccountResponse.status).toBe(200);
		}

		const finalHealth = await waitFor(
			() => readJson<{ accounts: number }>("/health"),
			(health) => health.accounts === 0,
		);
		expect(finalHealth.accounts).toBe(0);
	});
});
