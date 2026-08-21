import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@ccflare/config";
import { DatabaseFactory } from "@ccflare/database";
import { type Provider, providerRegistry } from "@ccflare/providers";
import type { Account, AccountCredentialManager } from "@ccflare/types";
import { stopAllOAuthCallbackForwarders } from "./handlers/oauth";
import { APIRouter } from "./router";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function createRouterContext(options?: {
	getProvider?: ConstructorParameters<typeof APIRouter>[0]["getProvider"];
	credentialManager?: AccountCredentialManager;
	retentionCleanupScheduler?: ConstructorParameters<
		typeof APIRouter
	>[0]["retentionCleanupScheduler"];
}) {
	const tempDir = mkdtempSync(join(tmpdir(), "ccflare-http-api-"));
	tempDirs.push(tempDir);

	const config = new Config(join(tempDir, "config.json"));
	DatabaseFactory.reset();
	DatabaseFactory.initialize(join(tempDir, "ccflare.db"));
	const dbOps = DatabaseFactory.getInstance();
	const getProvider =
		options?.getProvider ??
		((provider: Account["provider"]) => providerRegistry.getProvider(provider));
	const refresh = async (account: Account): Promise<Account> => {
		const provider = getProvider(account.provider);
		if (!provider?.refreshToken || !account.refresh_token) {
			throw new Error("No refresh token is available for this account");
		}
		const result = await provider.refreshToken(
			account,
			config.getRuntime().clientId,
		);
		dbOps.updateAccountTokens(
			account.id,
			result.accessToken,
			result.expiresAt,
			result.refreshToken,
		);
		const stored = dbOps.getAccount(account.id);
		if (!stored) throw new Error("Account disappeared");
		return stored;
	};
	const credentialManager: AccountCredentialManager =
		options?.credentialManager ?? {
			async getValidAccount(account) {
				const stored = dbOps.getAccount(account.id) ?? account;
				return stored.access_token &&
					stored.expires_at !== null &&
					stored.expires_at - Date.now() > 30_000
					? stored
					: refresh(stored);
			},
			async refreshAfterUnauthorized(account, rejectedAccessToken) {
				const stored = dbOps.getAccount(account.id) ?? account;
				return stored.access_token &&
					stored.access_token !== rejectedAccessToken
					? stored
					: refresh(stored);
			},
		};

	return {
		config,
		dbOps,
		credentialManager,
		router: new APIRouter({
			config,
			dbOps,
			getProvider,
			getProviders: () => ["anthropic", "openai", "claude-code", "codex"],
			credentialManager,
			retentionCleanupScheduler: options?.retentionCleanupScheduler,
		}),
	};
}

function createRouter() {
	return createRouterContext().router;
}

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

async function apiRequest(
	router: APIRouter,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const request = new Request(`http://localhost:8080${path}`, {
		method,
		headers:
			body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const response = await router.handleRequest(new URL(request.url), request);
	expect(response).not.toBeNull();
	return response as Response;
}

async function createApiKeyAccount(
	router: APIRouter,
	overrides: Record<string, unknown> = {},
): Promise<{ accountId: string }> {
	const response = await apiRequest(router, "POST", "/api/accounts", {
		name: "test-account",
		provider: "anthropic",
		auth_method: "api_key",
		api_key: "test-key",
		...overrides,
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		data: { accountId: string };
	};
	return { accountId: body.data.accountId };
}

function installFetchMock(
	handler: (request: Request) => Response | Promise<Response>,
): void {
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) =>
			handler(new Request(input, init)),
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	stopAllOAuthCallbackForwarders();
	DatabaseFactory.reset();

	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

describe("APIRouter", () => {
	it("returns 404 for removed agent endpoints", async () => {
		const router = createRouter();

		for (const path of [
			"/api/agents",
			"/api/workspaces",
			"/api/config/model",
		]) {
			const response = await router.handleRequest(
				new URL(`http://localhost:8080${path}`),
				new Request(`http://localhost:8080${path}`),
			);

			expect(response).not.toBeNull();
			expect(response?.status).toBe(404);
		}
	});

	it("omits agent keys from the config response", async () => {
		const router = createRouter();
		const response = await router.handleRequest(
			new URL("http://localhost:8080/api/config"),
			new Request("http://localhost:8080/api/config"),
		);

		expect(response).not.toBeNull();
		expect(response?.status).toBe(200);

		const body = (await response?.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("default_agent_model");
		expect(Object.keys(body).some((key) => key.includes("agent"))).toBe(false);
	});

	it("validates config strategy, retention, and analytics inputs", async () => {
		const router = createRouter();

		const invalidStrategy = await apiRequest(
			router,
			"POST",
			"/api/config/strategy",
			{ strategy: "round_robin" },
		);
		expect(invalidStrategy.status).toBe(400);

		const invalidRetention = await apiRequest(
			router,
			"POST",
			"/api/config/retention",
			[],
		);
		expect(invalidRetention.status).toBe(400);

		const invalidRange = await apiRequest(
			router,
			"GET",
			"/api/analytics?range=12h",
		);
		expect(invalidRange.status).toBe(400);

		const invalidProvider = await apiRequest(
			router,
			"GET",
			"/api/analytics?providers=gemini",
		);
		expect(invalidProvider.status).toBe(400);
	});

	it("queues maintenance cleanup without waiting for database work", async () => {
		const { router } = createRouterContext({
			retentionCleanupScheduler: { runNow: () => "accepted" },
		});
		const response = await apiRequest(
			router,
			"POST",
			"/api/maintenance/cleanup",
		);
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			success: true,
			data: { status: "accepted" },
		});
	});

	it("reports an unavailable maintenance worker", async () => {
		const response = await apiRequest(
			createRouter(),
			"POST",
			"/api/maintenance/cleanup",
		);
		expect(response.status).toBe(503);
	});

	it("returns analytics with shared bucket metadata for the 1h range", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createAccount({
			name: "analytics-owner",
			provider: "openai",
			auth_method: "api_key",
			api_key: "sk-test",
		});
		const now = Date.now();

		dbOps.saveRequest(
			"analytics-one",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			account.id,
			200,
			true,
			null,
			50,
			0,
			{
				model: "gpt-4o-mini",
				totalTokens: 12,
				costUsd: 0.4,
				inputTokens: 5,
				outputTokens: 7,
			},
			{ timestamp: now - 30_000 },
		);

		const response = await apiRequest(router, "GET", "/api/analytics?range=1h");
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			meta: { range: string; bucket: string };
			timeSeries: Array<{ ts: number; requests: number }>;
			totals: { requests: number };
		};
		expect(body.meta).toEqual(
			expect.objectContaining({
				range: "1h",
				bucket: "1m",
			}),
		);
		expect(body.totals.requests).toBe(1);
		expect(body.timeSeries).toEqual([
			expect.objectContaining({
				requests: 1,
			}),
		]);
	});

	it("returns the supported providers from health", async () => {
		const router = createRouter();
		const response = await router.handleRequest(
			new URL("http://localhost:8080/health"),
			new Request("http://localhost:8080/health"),
		);

		expect(response).not.toBeNull();
		expect(response?.status).toBe(200);

		const body = (await response?.json()) as {
			providers: string[];
			status: string;
		};
		expect(body.status).toBe("ok");
		expect(body.providers).toEqual([
			"anthropic",
			"openai",
			"claude-code",
			"codex",
		]);
	});

	it("includes runtime health details in the health response when available", async () => {
		const { config, dbOps, credentialManager } = createRouterContext();
		const router = new APIRouter({
			config,
			dbOps,
			getProvider: (provider) => providerRegistry.getProvider(provider),
			getProviders: () => ["anthropic", "openai", "claude-code", "codex"],
			credentialManager,
			getRuntimeHealth: () => ({
				asyncWriter: {
					healthy: true,
					failureCount: 0,
					queuedJobs: 0,
				},
				usageWorker: {
					state: "ready",
					queuedMessages: 0,
					pendingAcks: 0,
					lastError: null,
				},
			}),
		});

		const response = await router.handleRequest(
			new URL("http://localhost:8080/health"),
			new Request("http://localhost:8080/health"),
		);
		expect(response).not.toBeNull();

		const body = (await response?.json()) as {
			runtime: {
				asyncWriter: {
					healthy: boolean;
					failureCount: number;
					queuedJobs: number;
				};
				usageWorker: { state: string };
			};
		};
		expect(body.runtime.asyncWriter).toEqual({
			healthy: true,
			failureCount: 0,
			queuedJobs: 0,
		});
		expect(body.runtime.usageWorker.state).toBe("ready");
	});

	it("validates account creation payloads", async () => {
		const router = createRouter();

		const missingProvider = await apiRequest(router, "POST", "/api/accounts", {
			name: "missing-provider",
			auth_method: "api_key",
			api_key: "test-key",
		});
		expect(missingProvider.status).toBe(400);

		const unknownProvider = await apiRequest(router, "POST", "/api/accounts", {
			name: "unknown-provider",
			provider: "gemini",
			auth_method: "api_key",
			api_key: "test-key",
		});
		expect(unknownProvider.status).toBe(400);
		expect((await unknownProvider.json()) as { error: string }).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("claude-code"),
			}),
		);

		const missingName = await apiRequest(router, "POST", "/api/accounts", {
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "test-key",
		});
		expect(missingName.status).toBe(400);

		await createApiKeyAccount(router, { name: "duplicate-name" });
		const duplicateName = await apiRequest(router, "POST", "/api/accounts", {
			name: "duplicate-name",
			provider: "openai",
			auth_method: "api_key",
			api_key: "test-key",
		});
		expect(duplicateName.status).toBe(400);

		const missingApiKey = await apiRequest(router, "POST", "/api/accounts", {
			name: "missing-api-key",
			provider: "openai",
			auth_method: "api_key",
		});
		expect(missingApiKey.status).toBe(400);

		const unexpectedField = await apiRequest(router, "POST", "/api/accounts", {
			name: "unexpected-field",
			provider: "openai",
			auth_method: "api_key",
			api_key: "test-key",
			legacy_setting: "unsupported",
		});
		expect(unexpectedField.status).toBe(400);
	});

	it("accepts all 4 providers with the matching auth_method", async () => {
		const router = createRouter();

		const anthropicResponse = await apiRequest(
			router,
			"POST",
			"/api/accounts",
			{
				name: "anthropic-key",
				provider: "anthropic",
				auth_method: "api_key",
				api_key: "sk-ant-test",
			},
		);
		expect(anthropicResponse.status).toBe(200);

		const openAiResponse = await apiRequest(router, "POST", "/api/accounts", {
			name: "openai-key",
			provider: "openai",
			auth_method: "api_key",
			api_key: "sk-openai-test",
		});
		expect(openAiResponse.status).toBe(200);

		const claudeCodeResponse = await apiRequest(
			router,
			"POST",
			"/api/accounts",
			{
				name: "claude-code-oauth",
				provider: "claude-code",
				auth_method: "oauth",
				access_token: "claude-access-token",
			},
		);
		expect(claudeCodeResponse.status).toBe(200);

		const codexResponse = await apiRequest(router, "POST", "/api/accounts", {
			name: "codex-oauth",
			provider: "codex",
			auth_method: "oauth",
			access_token: "codex-access-token",
		});
		expect(codexResponse.status).toBe(200);

		const accounts = (await (
			await apiRequest(router, "GET", "/api/accounts")
		).json()) as Array<{
			name: string;
			provider: string;
			auth_method: string;
		}>;
		expect(accounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "anthropic-key",
					provider: "anthropic",
					auth_method: "api_key",
				}),
				expect.objectContaining({
					name: "openai-key",
					provider: "openai",
					auth_method: "api_key",
				}),
				expect.objectContaining({
					name: "claude-code-oauth",
					provider: "claude-code",
					auth_method: "oauth",
				}),
				expect.objectContaining({
					name: "codex-oauth",
					provider: "codex",
					auth_method: "oauth",
				}),
			]),
		);
	});

	it("rejects auth_method values that do not match the provider restrictions", async () => {
		const router = createRouter();

		const anthropicOauth = await apiRequest(router, "POST", "/api/accounts", {
			name: "anthropic-oauth",
			provider: "anthropic",
			auth_method: "oauth",
			access_token: "anthropic-access-token",
		});
		expect(anthropicOauth.status).toBe(400);
		expect((await anthropicOauth.json()) as { error: string }).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("anthropic"),
			}),
		);

		const openAiOauth = await apiRequest(router, "POST", "/api/accounts", {
			name: "openai-oauth",
			provider: "openai",
			auth_method: "oauth",
			access_token: "openai-access-token",
		});
		expect(openAiOauth.status).toBe(400);
		expect((await openAiOauth.json()) as { error: string }).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("api_key"),
			}),
		);

		const claudeCodeApiKey = await apiRequest(router, "POST", "/api/accounts", {
			name: "claude-code-api-key",
			provider: "claude-code",
			auth_method: "api_key",
			api_key: "sk-claude-code",
		});
		expect(claudeCodeApiKey.status).toBe(400);
		expect((await claudeCodeApiKey.json()) as { error: string }).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("claude-code"),
			}),
		);

		const codexApiKey = await apiRequest(router, "POST", "/api/accounts", {
			name: "codex-api-key",
			provider: "codex",
			auth_method: "api_key",
			api_key: "sk-codex",
		});
		expect(codexApiKey.status).toBe(400);
		expect((await codexApiKey.json()) as { error: string }).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("oauth"),
			}),
		);

		const grokApiKey = await apiRequest(router, "POST", "/api/accounts", {
			name: "grok-api-key",
			provider: "grok",
			auth_method: "api_key",
			api_key: "xai-key",
		});
		expect(grokApiKey.status).toBe(400);
		expect(await grokApiKey.text()).toContain("oauth");
	});

	it("lists provider, auth_method, and base_url for created accounts", async () => {
		const router = createRouter();

		await createApiKeyAccount(router, {
			name: "anthropic-key",
			base_url: "https://anthropic.internal",
		});
		await createApiKeyAccount(router, {
			name: "openai-key",
			provider: "openai",
			base_url: "https://openai.internal/v1",
		});

		const response = await apiRequest(router, "GET", "/api/accounts");
		expect(response.status).toBe(200);

		const accounts = (await response.json()) as Array<{
			name: string;
			provider: string;
			auth_method: string;
			base_url: string | null;
			oauthSubject: string | null;
		}>;
		expect(accounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "anthropic-key",
					provider: "anthropic",
					auth_method: "api_key",
					base_url: "https://anthropic.internal",
				}),
				expect.objectContaining({
					name: "openai-key",
					provider: "openai",
					auth_method: "api_key",
					base_url: "https://openai.internal/v1",
				}),
			]),
		);
	});

	it("uses weight-only account responses", async () => {
		const router = createRouter();

		const createResponse = await apiRequest(router, "POST", "/api/accounts", {
			name: "weight-default",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
		});
		expect(createResponse.status).toBe(200);
		const createBody = (await createResponse.json()) as {
			success: boolean;
			message: string;
			data: {
				accountId: string;
				weight: number;
				authMethod: string;
			};
		};
		expect(createBody).toEqual({
			success: true,
			message: "Account 'weight-default' added successfully",
			data: {
				accountId: expect.any(String),
				weight: 1,
				authMethod: "api_key",
			},
		});

		const listResponse = await apiRequest(router, "GET", "/api/accounts");
		expect(listResponse.status).toBe(200);
		const accounts = (await listResponse.json()) as Array<{
			id: string;
			name: string;
			provider: string;
			auth_method: string;
			base_url: string | null;
			oauthSubject: string | null;
			requestCount: number;
			totalRequests: number;
			lastUsed: string | null;
			created: string;
			weight: number;
			paused: boolean;
			tokenStatus: "valid" | "expired";
			tokenExpiresAt: string | null;
			rateLimitStatus: {
				code: string;
				isLimited: boolean;
				until: string | null;
			};
			rateLimitReset: string | null;
			rateLimitRemaining: number | null;
			sessionInfo: {
				active: boolean;
				startedAt: string | null;
				requestCount: number;
			};
			quota: unknown;
		}>;
		expect(accounts).toEqual([
			{
				id: createBody.data.accountId,
				name: "weight-default",
				provider: "anthropic",
				auth_method: "api_key",
				base_url: null,
				oauthSubject: null,
				requestCount: 0,
				totalRequests: 0,
				lastUsed: null,
				created: expect.any(String),
				weight: 1,
				paused: false,
				tokenStatus: "expired",
				tokenExpiresAt: null,
				rateLimitStatus: {
					code: "ok",
					isLimited: false,
					until: null,
				},
				rateLimitReset: null,
				rateLimitRemaining: null,
				sessionInfo: {
					active: false,
					startedAt: null,
					requestCount: 0,
				},
				quota: null,
			},
		]);
	});

	it("deletes accounts by id", async () => {
		const router = createRouter();
		const { accountId } = await createApiKeyAccount(router, {
			name: "deletable-account",
		});

		const deleteResponse = await apiRequest(
			router,
			"DELETE",
			`/api/accounts/${accountId}`,
		);
		expect(deleteResponse.status).toBe(200);

		const listResponse = await apiRequest(router, "GET", "/api/accounts");
		const accounts = (await listResponse.json()) as Array<{ id: string }>;
		expect(accounts).toEqual([]);
	});

	it("pauses and resumes accounts idempotently", async () => {
		const router = createRouter();
		const { accountId } = await createApiKeyAccount(router, {
			name: "pauseable-account",
		});

		const firstPause = await apiRequest(
			router,
			"POST",
			`/api/accounts/${accountId}/pause`,
		);
		const secondPause = await apiRequest(
			router,
			"POST",
			`/api/accounts/${accountId}/pause`,
		);
		expect(firstPause.status).toBe(200);
		expect(secondPause.status).toBe(200);

		const pausedAccounts = (await (
			await apiRequest(router, "GET", "/api/accounts")
		).json()) as Array<{ id: string; paused: boolean }>;
		expect(pausedAccounts).toEqual([
			expect.objectContaining({ id: accountId, paused: true }),
		]);

		const firstResume = await apiRequest(
			router,
			"POST",
			`/api/accounts/${accountId}/resume`,
		);
		const secondResume = await apiRequest(
			router,
			"POST",
			`/api/accounts/${accountId}/resume`,
		);
		expect(firstResume.status).toBe(200);
		expect(secondResume.status).toBe(200);

		const resumedAccounts = (await (
			await apiRequest(router, "GET", "/api/accounts")
		).json()) as Array<{ id: string; paused: boolean }>;
		expect(resumedAccounts).toEqual([
			expect.objectContaining({ id: accountId, paused: false }),
		]);
	});

	it("updates accounts via PATCH", async () => {
		const router = createRouter();
		const { accountId } = await createApiKeyAccount(router, {
			name: "rename-me",
		});

		const patchResponse = await apiRequest(
			router,
			"PATCH",
			`/api/accounts/${accountId}`,
			{
				name: "renamed-account",
				base_url: "https://custom.endpoint/v1",
			},
		);
		expect(patchResponse.status).toBe(200);

		const accounts = (await (
			await apiRequest(router, "GET", "/api/accounts")
		).json()) as Array<{
			id: string;
			name: string;
			base_url: string | null;
		}>;
		expect(accounts).toEqual([
			expect.objectContaining({
				id: accountId,
				name: "renamed-account",
				base_url: "https://custom.endpoint/v1",
			}),
		]);

		const unexpectedFieldResponse = await apiRequest(
			router,
			"PATCH",
			`/api/accounts/${accountId}`,
			{
				name: "still-renamed-account",
				legacy_setting: "unsupported",
			},
		);
		expect(unexpectedFieldResponse.status).toBe(400);
	});

	it("fetches collective Claude Code quota after refreshing expired credentials", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "quota-owner",
			provider: "claude-code",
			accessToken: "expired-access-token",
			refreshToken: "rotating-refresh-token",
			expiresAt: Date.now() - 1,
		});
		const requestedUrls: string[] = [];

		installFetchMock(async (request) => {
			requestedUrls.push(request.url);
			if (request.url === "https://platform.claude.com/v1/oauth/token") {
				expect(await request.text()).toContain(
					'"refresh_token":"rotating-refresh-token"',
				);
				return Response.json({
					access_token: "fresh-access-token",
					refresh_token: "fresh-refresh-token",
					expires_in: 3600,
				});
			}
			if (request.url.endsWith("/api/oauth/usage")) {
				expect(request.headers.get("authorization")).toBe(
					"Bearer fresh-access-token",
				);
				return Response.json({
					five_hour: { utilization: 25 },
					access_token: "upstream-secret",
				});
			}
			if (request.url.endsWith("/api/oauth/profile")) {
				return Response.json({ subscription_type: "max" });
			}
			return Response.json({ error: "unexpected URL" }, { status: 500 });
		});

		const response = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/quota`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			account: { id: string; provider: string };
			state: string;
			windows: Array<{ id: string; usedPercent: number }>;
			sources: Record<string, { data?: unknown }>;
		};
		expect(body).toEqual(
			expect.objectContaining({
				account: expect.objectContaining({
					id: account.id,
					provider: "claude-code",
				}),
				state: "ok",
				windows: [
					expect.objectContaining({
						id: "claude-code:account:5h",
						usedPercent: 25,
					}),
				],
				sources: {
					usage: expect.objectContaining({
						data: {
							five_hour: { utilization: 25 },
							access_token: "[REDACTED]",
						},
					}),
					profile: expect.objectContaining({
						data: { subscription_type: "max" },
					}),
				},
			}),
		);
		expect(requestedUrls).toEqual([
			"https://platform.claude.com/v1/oauth/token",
			"https://api.anthropic.com/api/oauth/usage",
			"https://api.anthropic.com/api/oauth/profile",
		]);
		expect(dbOps.getAccount(account.id)).toEqual(
			expect.objectContaining({
				access_token: "fresh-access-token",
				refresh_token: "fresh-refresh-token",
			}),
		);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("fresh-access-token");
		expect(serialized).not.toContain("fresh-refresh-token");
		expect(serialized).not.toContain("upstream-secret");

		const accountsResponse = await apiRequest(router, "GET", "/api/accounts");
		const accounts = (await accountsResponse.json()) as Array<{
			id: string;
			quota: { state: string; windows: Array<{ id: string }> } | null;
		}>;
		expect(accounts.find((item) => item.id === account.id)?.quota).toEqual(
			expect.objectContaining({
				state: "fresh",
				windows: [expect.objectContaining({ id: "claude-code:account:5h" })],
			}),
		);

		installFetchMock(() =>
			Response.json({ error: "temporarily unavailable" }, { status: 503 }),
		);
		const failedRefresh = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/quota`,
		);
		expect(failedRefresh.status).toBe(502);
		expect(dbOps.getAccountQuotaSnapshot(account.id)).toEqual(
			expect.objectContaining({
				state: "stale",
				windows: [expect.objectContaining({ id: "claude-code:account:5h" })],
			}),
		);

		installFetchMock((request) =>
			request.url.endsWith("/api/oauth/profile")
				? Response.json({ subscription_type: "max" })
				: Response.json({ error: "usage unavailable" }, { status: 503 }),
		);
		const partialRefresh = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/quota`,
		);
		expect(partialRefresh.status).toBe(200);
		expect(dbOps.getAccountQuotaSnapshot(account.id)).toEqual(
			expect.objectContaining({
				state: "stale",
				windows: [expect.objectContaining({ id: "claude-code:account:5h" })],
			}),
		);
	});

	it("returns sanitized sign-in-required 401s for OAuth refresh rejections", async () => {
		const providers = [
			{ provider: "kimi", label: "Kimi" },
			{ provider: "codex", label: "Codex" },
			{ provider: "claude-code", label: "Claude Code" },
		] as const;
		const failures = [
			{ status: 400, code: "invalid_grant" },
			{ status: 401, code: "invalid_token" },
			{ status: 403, code: "access_denied" },
		] as const;

		for (const { provider, label } of providers) {
			for (const failure of failures) {
				const { router, dbOps } = createRouterContext();
				const account = dbOps.createOAuthAccount({
					name: `${provider}-${failure.status}`,
					provider,
					accessToken: `secret-access-${provider}`,
					refreshToken: `secret-refresh-${provider}`,
					expiresAt: Date.now() - 1,
				});
				installFetchMock(() =>
					Response.json(
						{
							error: failure.code,
							error_description: `rejected secret-refresh-${provider}`,
							raw_payload_secret: "must-not-leak",
						},
						{ status: failure.status },
					),
				);

				const response = await apiRequest(
					router,
					"GET",
					`/api/accounts/${account.id}/quota`,
				);
				expect(response.status).toBe(401);
				const serialized = await response.text();
				expect(JSON.parse(serialized)).toEqual({
					error: `${label} account '${account.name}' must sign in again`,
				});
				expect(serialized).not.toContain("secret-access");
				expect(serialized).not.toContain("secret-refresh");
				expect(serialized).not.toContain("must-not-leak");
			}
		}
	}, 20_000);

	it("returns 401 for model credential rejection and 502 for a temporary refresh failure", async () => {
		const modelContext = createRouterContext();
		const modelAccount = modelContext.dbOps.createOAuthAccount({
			name: "models-signin",
			provider: "codex",
			accessToken: "expired-model-access",
			refreshToken: "revoked-model-refresh",
			expiresAt: Date.now() - 1,
		});
		installFetchMock(() =>
			Response.json(
				{ error: "invalid_grant", error_description: "revoked" },
				{ status: 400 },
			),
		);
		const modelResponse = await apiRequest(
			modelContext.router,
			"GET",
			`/api/accounts/${modelAccount.id}/models`,
		);
		expect(modelResponse.status).toBe(401);
		expect(await modelResponse.json()).toEqual({
			error: "Codex account 'models-signin' must sign in again",
		});

		const quotaContext = createRouterContext();
		const quotaAccount = quotaContext.dbOps.createOAuthAccount({
			name: "temporary-kimi",
			provider: "kimi",
			accessToken: "expired-kimi-access",
			refreshToken: "temporary-kimi-refresh",
			expiresAt: Date.now() - 1,
		});
		installFetchMock(() =>
			Response.json(
				{ error: "temporarily_unavailable", error_description: "try later" },
				{ status: 503 },
			),
		);
		const quotaResponse = await apiRequest(
			quotaContext.router,
			"GET",
			`/api/accounts/${quotaAccount.id}/quota`,
		);
		expect(quotaResponse.status).toBe(502);
		expect(await quotaResponse.json()).toEqual(
			expect.objectContaining({ error: "Failed to fetch account quota" }),
		);
	});

	it("deduplicates concurrent live quota refreshes for the same account", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "concurrent-quota-owner",
			provider: "claude-code",
			accessToken: "current-access-token",
			refreshToken: "current-refresh-token",
			expiresAt: Date.now() + 60_000,
		});
		let requests = 0;
		installFetchMock(async () => {
			requests++;
			await Promise.resolve();
			return Response.json({ five_hour: { utilization: 10 } });
		});

		const path = `/api/accounts/${account.id}/quota`;
		const [first, second] = await Promise.all([
			apiRequest(router, "GET", path),
			apiRequest(router, "GET", path),
		]);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(requests).toBe(2);
	});

	it("persists provider-supplied windows when raw source shapes evolve", async () => {
		const provider = {
			fetchQuota: async () => ({
				state: "ok" as const,
				collectedAt: "2026-08-04T00:00:00.000Z",
				windows: [
					{
						id: "codex:model:future:30d",
						label: "Future model monthly limit",
						period: "30d",
						scope: "model" as const,
						model: "future-model",
						usedPercent: 42,
					},
				],
				sources: {
					usage: {
						state: "ok" as const,
						status: 200,
						data: { future_quota_envelope: true },
					},
				},
			}),
		} as unknown as Provider;
		const { router, dbOps } = createRouterContext({
			getProvider: () => provider,
		});
		const account = dbOps.createOAuthAccount({
			name: "future-shape-owner",
			provider: "codex",
			accessToken: "current-access-token",
			refreshToken: "current-refresh-token",
			expiresAt: Date.now() + 60_000,
		});

		const response = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/quota`,
		);
		expect(response.status).toBe(200);
		expect((await response.json()) as { windows: unknown[] }).toEqual(
			expect.objectContaining({
				windows: [
					expect.objectContaining({
						id: "codex:model:future:30d",
						usedPercent: 42,
					}),
				],
			}),
		);
		expect(dbOps.getAccountQuotaSnapshot(account.id)?.windows).toEqual([
			expect.objectContaining({ id: "codex:model:future:30d" }),
		]);
	});

	it("clears only local rate-limit state and retains cached quota", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "limited-owner",
			provider: "codex",
			accessToken: "access-token",
			refreshToken: "refresh-token",
			expiresAt: Date.now() + 60_000,
		});
		dbOps.markAccountRateLimited(account.id, Date.now() + 300_000);
		dbOps.updateAccountRateLimitMeta(
			account.id,
			"rate_limited",
			Date.now() + 300_000,
			0,
		);
		dbOps.saveAccountQuotaSuccess({
			accountId: account.id,
			windows: [
				{
					id: "codex:account:main:5h",
					label: "5-hour limit",
					period: "5h",
					scope: "account",
					usedPercent: 100,
				},
			],
			collectedAt: "2026-08-04T00:00:00.000Z",
			lastAttemptAt: "2026-08-04T00:00:00.000Z",
		});

		const response = await apiRequest(
			router,
			"POST",
			`/api/accounts/${account.id}/rate-limit/reset`,
		);
		expect(response.status).toBe(200);
		expect(dbOps.getAccount(account.id)).toEqual(
			expect.objectContaining({
				rate_limited_until: null,
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limit_remaining: null,
			}),
		);
		expect(dbOps.getAccountQuotaSnapshot(account.id)?.windows).toHaveLength(1);
	});

	it("refreshes and retries once when all quota probes reject a current token", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "stale-quota-owner",
			provider: "claude-code",
			accessToken: "apparently-current-token",
			refreshToken: "stale-refresh-token",
			expiresAt: Date.now() + 60_000,
		});
		let staleQuotaRequests = 0;
		let freshQuotaRequests = 0;

		installFetchMock((request) => {
			if (request.url === "https://platform.claude.com/v1/oauth/token") {
				return Response.json({
					access_token: "retried-access-token",
					refresh_token: "retried-refresh-token",
					expires_in: 3600,
				});
			}
			if (
				request.headers.get("authorization") ===
				"Bearer apparently-current-token"
			) {
				staleQuotaRequests++;
				return Response.json({ error: "invalid token" }, { status: 401 });
			}

			expect(request.headers.get("authorization")).toBe(
				"Bearer retried-access-token",
			);
			freshQuotaRequests++;
			return Response.json({ available: true });
		});

		const response = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/quota`,
		);
		expect(response.status).toBe(200);
		expect((await response.json()) as { state: string }).toEqual(
			expect.objectContaining({ state: "ok" }),
		);
		expect(staleQuotaRequests).toBe(2);
		expect(freshQuotaRequests).toBe(2);
		expect(dbOps.getAccount(account.id)).toEqual(
			expect.objectContaining({
				access_token: "retried-access-token",
				refresh_token: "retried-refresh-token",
			}),
		);
	});

	it("fetches Kimi quota from /usages after refreshing expired credentials", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "kimi-quota-owner",
			provider: "kimi",
			accessToken: "expired-kimi-access-token",
			refreshToken: "rotating-kimi-refresh-token",
			expiresAt: Date.now() - 1,
		});
		const requestedUrls: string[] = [];

		installFetchMock(async (request) => {
			requestedUrls.push(request.url);
			if (request.url === "https://auth.kimi.com/api/oauth/token") {
				expect(await request.text()).toContain(
					"refresh_token=rotating-kimi-refresh-token",
				);
				return Response.json({
					access_token: "fresh-kimi-access-token",
					refresh_token: "fresh-kimi-refresh-token",
					expires_in: 900,
				});
			}
			if (request.url.endsWith("/usages")) {
				expect(request.headers.get("authorization")).toBe(
					"Bearer fresh-kimi-access-token",
				);
				return Response.json({
					usage: { name: "Weekly limit", used: 40, limit: 1000 },
					limits: [{ detail: { name: "5h limit", used: 1, limit: 100 } }],
					refresh_token: "upstream-secret",
				});
			}
			return Response.json({ error: "unexpected URL" }, { status: 500 });
		});

		const response = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/quota`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			account: { id: string; provider: string };
			state: string;
			sources: Record<string, { data?: unknown }>;
		};
		expect(body).toEqual(
			expect.objectContaining({
				account: expect.objectContaining({
					id: account.id,
					provider: "kimi",
				}),
				state: "ok",
				sources: {
					usage: expect.objectContaining({
						data: {
							usage: { name: "Weekly limit", used: 40, limit: 1000 },
							limits: [{ detail: { name: "5h limit", used: 1, limit: 100 } }],
							refresh_token: "[REDACTED]",
						},
					}),
				},
			}),
		);
		expect(requestedUrls).toEqual([
			"https://auth.kimi.com/api/oauth/token",
			"https://api.kimi.com/coding/v1/usages",
		]);
		expect(dbOps.getAccount(account.id)).toEqual(
			expect.objectContaining({
				access_token: "fresh-kimi-access-token",
				refresh_token: "fresh-kimi-refresh-token",
			}),
		);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("fresh-kimi-access-token");
		expect(serialized).not.toContain("fresh-kimi-refresh-token");
		expect(serialized).not.toContain("upstream-secret");
	});

	it("fetches Grok quota and models with the verified subject through management routes", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "grok-control-plane-owner",
			provider: "grok",
			accessToken: "grok-control-access",
			refreshToken: "grok-control-refresh",
			expiresAt: Date.now() + 60_000,
			oauthSubject: "verified-grok-user",
		});
		dbOps.markAccountRateLimited(account.id, Date.now() + 300_000);
		const requestedUrls: string[] = [];

		installFetchMock((request) => {
			requestedUrls.push(request.url);
			expect(request.headers.get("authorization")).toBe(
				"Bearer grok-control-access",
			);
			expect(request.headers.get("x-userid")).toBe("verified-grok-user");
			expect(request.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
			expect(request.headers.get("x-grok-client-version")).toBe("1.0.6");
			if (request.url.endsWith("/billing?format=credits")) {
				return Response.json({
					config: {
						currentPeriod: {
							type: "USAGE_PERIOD_TYPE_WEEKLY",
							start: "2026-08-20T00:00:00Z",
							end: "2026-08-27T00:00:00Z",
						},
						onDemandCap: { val: 0 },
						onDemandUsed: { val: 0 },
					},
				});
			}
			if (request.url.endsWith("/models")) {
				return Response.json({
					data: [
						{
							model: "grok-live-control-plane",
							name: "Grok Live Control Plane",
							reasoning_effort: "high",
							reasoning_efforts: [{ value: "high" }],
						},
					],
				});
			}
			return Response.json({ error: "unexpected URL" }, { status: 500 });
		});

		const quotaResponse = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/quota`,
		);
		expect(quotaResponse.status).toBe(200);
		expect(await quotaResponse.json()).toEqual(
			expect.objectContaining({
				account: expect.objectContaining({ provider: "grok" }),
				state: "ok",
				windows: [
					expect.objectContaining({
						id: "grok:included",
						usedPercent: 0,
					}),
				],
			}),
		);
		expect(dbOps.getAccount(account.id)?.rate_limited_until).toBeNull();
		const accountsResponse = await apiRequest(router, "GET", "/api/accounts");
		expect(accountsResponse.status).toBe(200);
		expect(await accountsResponse.json()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: account.id,
					quota: expect.objectContaining({
						state: "fresh",
						windows: [
							expect.objectContaining({
								id: "grok:included",
								usedPercent: 0,
							}),
						],
					}),
				}),
			]),
		);

		const modelsResponse = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/models`,
		);
		expect(modelsResponse.status).toBe(200);
		expect(await modelsResponse.json()).toEqual(
			expect.objectContaining({
				account: expect.objectContaining({ provider: "grok" }),
				state: "ok",
				versions: [
					expect.objectContaining({
						clientVersion: "1.0.6",
						models: [
							expect.objectContaining({
								slug: "grok-live-control-plane",
							}),
						],
					}),
				],
			}),
		);
		expect(requestedUrls).toEqual([
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			"https://cli-chat-proxy.grok.com/v1/models",
		]);
	});

	it("returns explicit account quota errors for missing and unsupported accounts", async () => {
		const { router } = createRouterContext();
		const missingResponse = await apiRequest(
			router,
			"GET",
			"/api/accounts/missing-account/quota",
		);
		expect(missingResponse.status).toBe(404);
		expect(await missingResponse.json()).toEqual({
			error: "Account not found",
		});

		const { accountId } = await createApiKeyAccount(router, {
			name: "unsupported-quota-owner",
		});
		const unsupportedResponse = await apiRequest(
			router,
			"GET",
			`/api/accounts/${accountId}/quota`,
		);
		expect(unsupportedResponse.status).toBe(501);
		expect(await unsupportedResponse.json()).toEqual({
			error: "Quota checks are not implemented for provider 'anthropic'",
			details: { provider: "anthropic" },
		});
	});

	it("returns 502 with secret-safe details when every quota source fails", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "unavailable-quota-owner",
			provider: "claude-code",
			accessToken: "valid-access-token",
			refreshToken: "valid-refresh-token",
			expiresAt: Date.now() + 60_000,
		});
		installFetchMock(() =>
			Response.json(
				{
					error: "upstream unavailable",
					access_token: "upstream-secret",
				},
				{ status: 503 },
			),
		);

		const response = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/quota`,
		);
		expect(response.status).toBe(502);
		const body = (await response.json()) as {
			error: string;
			details: { state: string };
		};
		expect(body.error).toBe("All provider quota sources failed");
		expect(body.details.state).toBe("failed");
		expect(JSON.stringify(body)).not.toContain("upstream-secret");
		expect(JSON.stringify(body)).not.toContain("valid-access-token");
	});

	it("fetches tiered Codex models after refreshing expired credentials", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "models-owner",
			provider: "codex",
			accessToken: "expired-access-token",
			refreshToken: "rotating-refresh-token",
			expiresAt: Date.now() - 1,
		});
		const requestedUrls: string[] = [];

		installFetchMock(async (request) => {
			requestedUrls.push(request.url);
			if (request.url === "https://auth.openai.com/oauth/token") {
				expect(await request.text()).toContain(
					"refresh_token=rotating-refresh-token",
				);
				return Response.json({
					access_token: "fresh-access-token",
					refresh_token: "fresh-refresh-token",
					expires_in: 3600,
				});
			}
			if (request.url.includes("/codex/models")) {
				expect(request.headers.get("authorization")).toBe(
					"Bearer fresh-access-token",
				);
				return Response.json({
					models: [
						{
							slug: "gpt-5.5",
							display_name: "GPT-5.5",
							supported_reasoning_levels: [
								{ effort: "low" },
								{ effort: "medium" },
								{ effort: "high" },
							],
						},
					],
				});
			}
			return Response.json({ error: "unexpected URL" }, { status: 500 });
		});

		const response = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/models`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			account: { id: string; provider: string };
			state: string;
			versions: Array<{
				clientVersion: string;
				state: string;
				culledCount?: number;
				models: Array<{ slug: string; hidden?: boolean }>;
			}>;
		};
		expect(body).toEqual(
			expect.objectContaining({
				account: expect.objectContaining({
					id: account.id,
					provider: "codex",
				}),
				state: "ok",
			}),
		);
		expect(body.versions.map((version) => version.clientVersion)).toEqual([
			"0.145.0",
			"0.144.1",
		]);
		const [latest, older] = body.versions;
		expect(latest.models.map((model) => model.slug)).toEqual([
			"gpt-5.5",
			"codex-auto-review",
		]);
		expect(
			latest.models.find((model) => model.slug === "codex-auto-review")?.hidden,
		).toBe(true);
		// Older tier is fully culled: identical gpt-5.5 effort combos.
		expect(older.models).toEqual([]);
		expect(older.culledCount).toBe(3);
		expect(requestedUrls).toEqual([
			"https://auth.openai.com/oauth/token",
			"https://chatgpt.com/backend-api/codex/models?client_version=0.145.0",
			"https://chatgpt.com/backend-api/codex/models?client_version=0.144.1",
		]);
		expect(dbOps.getAccount(account.id)).toEqual(
			expect.objectContaining({
				access_token: "fresh-access-token",
				refresh_token: "fresh-refresh-token",
			}),
		);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("fresh-access-token");
		expect(serialized).not.toContain("fresh-refresh-token");
	});

	it("returns explicit account models errors for missing and unsupported accounts", async () => {
		const { router, dbOps } = createRouterContext();
		const missingResponse = await apiRequest(
			router,
			"GET",
			"/api/accounts/missing-account/models",
		);
		expect(missingResponse.status).toBe(404);
		expect(await missingResponse.json()).toEqual({
			error: "Account not found",
		});

		const claudeAccount = dbOps.createOAuthAccount({
			name: "unsupported-models-owner",
			provider: "claude-code",
			accessToken: "valid-access-token",
			refreshToken: "valid-refresh-token",
			expiresAt: Date.now() + 60_000,
		});
		const unsupportedResponse = await apiRequest(
			router,
			"GET",
			`/api/accounts/${claudeAccount.id}/models`,
		);
		expect(unsupportedResponse.status).toBe(501);
		expect(await unsupportedResponse.json()).toEqual({
			error: "Model listing is not implemented for provider 'claude-code'",
			details: { provider: "claude-code" },
		});
	});

	it("returns 502 with secret-safe details when every model catalog request fails", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createOAuthAccount({
			name: "unavailable-models-owner",
			provider: "codex",
			accessToken: "valid-access-token",
			refreshToken: "valid-refresh-token",
			expiresAt: Date.now() + 60_000,
		});
		installFetchMock(() =>
			Response.json(
				{
					error: "upstream unavailable",
					access_token: "upstream-secret",
				},
				{ status: 503 },
			),
		);

		const response = await apiRequest(
			router,
			"GET",
			`/api/accounts/${account.id}/models`,
		);
		expect(response.status).toBe(502);
		const body = (await response.json()) as {
			error: string;
			details: { state: string };
		};
		expect(body.error).toBe("All provider model catalog requests failed");
		expect(body.details.state).toBe("failed");
		expect(JSON.stringify(body)).not.toContain("upstream-secret");
		expect(JSON.stringify(body)).not.toContain("valid-access-token");
	});

	it("resets stats consistently through the API", async () => {
		const { router, dbOps } = createRouterContext();
		const account = dbOps.createAccount({
			name: "reset-owner",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-test",
		});

		dbOps.updateAccountUsage(account.id);
		dbOps.saveRequest(
			"stats-reset-request",
			"POST",
			"/v1/anthropic/v1/messages",
			"anthropic",
			"/v1/messages",
			account.id,
			200,
			true,
			null,
			25,
			0,
		);

		const resetResponse = await apiRequest(router, "POST", "/api/stats/reset");
		expect(resetResponse.status).toBe(200);
		expect((await resetResponse.json()) as { success: boolean }).toEqual(
			expect.objectContaining({ success: true }),
		);

		const statsResponse = await apiRequest(router, "GET", "/api/stats");
		expect(statsResponse.status).toBe(200);
		expect(
			(await statsResponse.json()) as {
				totalRequests: number;
				recentErrors: string[];
				topModels: Array<{ model: string; count: number }>;
			},
		).toEqual(
			expect.objectContaining({
				totalRequests: 0,
				recentErrors: [],
				topModels: [],
			}),
		);

		expect(dbOps.getAccount(account.id)).toEqual(
			expect.objectContaining({
				request_count: 0,
				session_request_count: 0,
				session_start: null,
			}),
		);
	});

	it("preserves zero-valued usage fields in request summaries", async () => {
		const { router, dbOps } = createRouterContext();
		dbOps.saveRequest(
			"request-zero",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			0,
			0,
			{
				model: "gpt-4o-mini",
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				costUsd: 0,
				inputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				tokensPerSecond: 0,
			},
		);

		const response = await apiRequest(router, "GET", "/api/requests?limit=1");
		expect(response.status).toBe(200);
		expect((await response.json()) as Array<Record<string, unknown>>).toEqual([
			expect.objectContaining({
				id: "request-zero",
				method: "POST",
				provider: "openai",
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				inputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				costUsd: 0,
				tokensPerSecond: 0,
			}),
		]);
	});

	it("preserves null metadata fields in request summaries instead of omitting them", async () => {
		const { router, dbOps } = createRouterContext();
		dbOps.saveRequest(
			"request-null-metadata",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			0,
			0,
		);

		const response = await apiRequest(router, "GET", "/api/requests?limit=1");
		expect(response.status).toBe(200);
		expect((await response.json()) as Array<Record<string, unknown>>).toEqual([
			expect.objectContaining({
				id: "request-null-metadata",
				model: null,
				promptTokens: null,
				completionTokens: null,
				totalTokens: null,
				inputTokens: null,
				cacheReadInputTokens: null,
				cacheCreationInputTokens: null,
				outputTokens: null,
				reasoningTokens: null,
				costUsd: null,
				tokensPerSecond: null,
			}),
		]);
	});

	it("keeps request summaries keyed by account id and exposes account names separately", async () => {
		const { router, dbOps } = createRouterContext();
		const { accountId } = await createApiKeyAccount(router, {
			name: "request-owner",
			provider: "openai",
		});

		dbOps.saveRequest(
			"request-owner-summary",
			"POST",
			"/v1/openai/chat/completions",
			"openai",
			"/chat/completions",
			accountId,
			200,
			true,
			null,
			42,
			0,
		);

		const response = await apiRequest(router, "GET", "/api/requests?limit=1");
		expect(response.status).toBe(200);
		expect((await response.json()) as Array<Record<string, unknown>>).toEqual([
			expect.objectContaining({
				id: "request-owner-summary",
				accountUsed: accountId,
				accountName: "request-owner",
			}),
		]);
	});

	it("keeps multi-megabyte payloads out of summaries and returns only exact detail", async () => {
		const { router, dbOps } = createRouterContext();
		const { accountId } = await createApiKeyAccount(router, {
			name: "payload-owner",
		});

		const sentinel = `sentinel-${"x".repeat(3 * 1024 * 1024)}`;
		const payload = {
			id: "request-payload",
			request: { headers: { "x-test": "selected" }, body: sentinel },
			response: { status: 200, headers: {}, body: null },
			meta: {
				trace: {
					timestamp: 123,
					method: "POST" as const,
					path: "/v1/anthropic/v1/messages",
					provider: "anthropic" as const,
					upstreamPath: "/v1/messages",
				},
				account: { id: accountId },
				transport: { success: true, pending: false, retry: 0 },
			},
		};
		dbOps.saveRequest(
			payload.id,
			"POST",
			"/v1/anthropic/v1/messages",
			"anthropic",
			"/v1/messages",
			accountId,
			200,
			true,
			null,
			21,
			0,
			undefined,
			{ timestamp: 123, payload },
		);
		dbOps.saveRequest(
			"other-request",
			"POST",
			"/v1/anthropic/v1/messages",
			"anthropic",
			"/v1/messages",
			accountId,
			200,
			true,
			null,
			10,
			0,
			undefined,
			{
				timestamp: 124,
				payload: {
					...payload,
					id: "other-request",
					request: { headers: {}, body: "other-body" },
				},
			},
		);

		const summaryResponse = await apiRequest(
			router,
			"GET",
			"/api/requests?limit=200",
		);
		const summaryText = await summaryResponse.text();
		expect(summaryResponse.status).toBe(200);
		expect(summaryText).not.toContain("sentinel-");
		expect(summaryText).not.toContain("other-body");

		const response = await apiRequest(
			router,
			"GET",
			"/api/requests/request-payload/detail",
		);
		expect(response.status).toBe(200);
		const detailText = await response.text();
		expect(detailText).toContain(sentinel);
		expect(detailText).not.toContain("other-body");
		expect(JSON.parse(detailText) as Record<string, unknown>).toEqual(
			expect.objectContaining({
				id: "request-payload",
				meta: {
					trace: {
						timestamp: 123,
						method: "POST",
						path: "/v1/anthropic/v1/messages",
						provider: "anthropic",
						upstreamPath: "/v1/messages",
					},
					account: {
						id: accountId,
						name: "payload-owner",
					},
					transport: {
						success: true,
						pending: false,
						retry: 0,
					},
				},
			}),
		);
	});

	it("returns metadata detail fallbacks and 404 for unknown or removed bulk routes", async () => {
		const { router, dbOps } = createRouterContext();
		dbOps.saveRequestMeta(
			"pending",
			"POST",
			"/pending",
			"openai",
			"/pending",
			null,
			null,
			10,
		);
		dbOps.saveRequestMeta(
			"websocket",
			"WS",
			"/socket",
			"openai",
			"/socket",
			null,
			101,
			11,
		);
		dbOps.saveRequestMeta(
			"missing",
			"POST",
			"/missing",
			"openai",
			"/missing",
			null,
			200,
			12,
		);
		dbOps.saveRequest(
			"missing",
			"POST",
			"/missing",
			"openai",
			"/missing",
			null,
			200,
			true,
			null,
			5,
			0,
		);
		dbOps.saveRequest(
			"malformed",
			"POST",
			"/bad",
			"openai",
			"/bad",
			null,
			500,
			false,
			"bad response",
			5,
			0,
		);
		dbOps.saveRequestPayload("malformed", { invalid: true });

		for (const [id, expected] of [
			["pending", { pending: true, isStream: false }],
			["websocket", { pending: true, isStream: true }],
			["missing", { pending: false, isStream: false }],
			["malformed", { pending: false, isStream: false }],
		] as const) {
			const response = await apiRequest(
				router,
				"GET",
				`/api/requests/${id}/detail`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				id,
				request: { headers: {}, body: null },
				meta: { transport: expected },
			});
		}

		expect(
			(await apiRequest(router, "GET", "/api/requests/unknown/detail")).status,
		).toBe(404);
		expect(
			(await apiRequest(router, "GET", "/api/requests/detail?limit=200"))
				.status,
		).toBe(404);
	});

	it("returns conversation chains by request or client session id", async () => {
		const { router, dbOps } = createRouterContext();

		dbOps.saveRequest(
			"request-root",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			10,
			0,
			undefined,
			{
				timestamp: 1_000,
				payload: {
					id: "request-root",
					request: {
						headers: { "x-ccflare-session-id": "session-conversation" },
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "root",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-root"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 1_000 },
						account: { id: null },
						transport: { success: true },
					},
				},
			},
		);
		dbOps.saveRequest(
			"request-child",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			10,
			0,
			undefined,
			{
				timestamp: 2_000,
				payload: {
					id: "request-child",
					request: {
						headers: { "x-ccflare-session-id": "session-conversation" },
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "child",
								previous_response_id: "resp-root",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-child"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 2_000 },
						account: { id: null },
						transport: { success: true },
					},
				},
			},
		);
		dbOps.saveRequest(
			"request-grandchild",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			10,
			0,
			undefined,
			{
				timestamp: 3_000,
				payload: {
					id: "request-grandchild",
					request: {
						headers: { "x-ccflare-session-id": "session-conversation" },
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "grandchild",
								previous_response_id: "resp-child",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-grandchild"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 3_000 },
						account: { id: null },
						transport: { success: true },
					},
				},
			},
		);

		const response = await apiRequest(
			router,
			"GET",
			"/api/requests/request-child/conversation",
		);
		expect(response.status).toBe(200);
		expect(
			((await response.json()) as Array<{ id: string }>).map((row) => row.id),
		).toEqual(["request-root", "request-child"]);

		const sessionResponse = await apiRequest(
			router,
			"GET",
			"/api/requests/session-conversation/conversation",
		);
		expect(sessionResponse.status).toBe(200);
		expect(
			((await sessionResponse.json()) as Array<{ id: string }>).map(
				(row) => row.id,
			),
		).toEqual(["request-root", "request-child", "request-grandchild"]);
	});

	it("excludes sibling branches from the request conversation endpoint", async () => {
		const { router, dbOps } = createRouterContext();

		dbOps.saveRequest(
			"root",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			10,
			0,
			undefined,
			{
				timestamp: 1_000,
				payload: {
					id: "root",
					request: {
						headers: {},
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "root",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-root"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 1_000 },
						account: { id: null },
						transport: { success: true },
					},
				},
			},
		);
		dbOps.saveRequest(
			"branch-a",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			10,
			0,
			undefined,
			{
				timestamp: 2_000,
				payload: {
					id: "branch-a",
					request: {
						headers: {},
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "branch-a",
								previous_response_id: "resp-root",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-a"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 2_000 },
						account: { id: null },
						transport: { success: true },
					},
				},
			},
		);
		dbOps.saveRequest(
			"branch-b",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			10,
			0,
			undefined,
			{
				timestamp: 3_000,
				payload: {
					id: "branch-b",
					request: {
						headers: {},
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "branch-b",
								previous_response_id: "resp-root",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-b"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 3_000 },
						account: { id: null },
						transport: { success: true },
					},
				},
			},
		);
		dbOps.saveRequest(
			"leaf-a",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			200,
			true,
			null,
			10,
			0,
			undefined,
			{
				timestamp: 4_000,
				payload: {
					id: "leaf-a",
					request: {
						headers: {},
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "leaf-a",
								previous_response_id: "resp-a",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-leaf-a"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 4_000 },
						account: { id: null },
						transport: { success: true },
					},
				},
			},
		);

		const response = await apiRequest(
			router,
			"GET",
			"/api/requests/leaf-a/conversation",
		);
		expect(response.status).toBe(200);
		expect(
			((await response.json()) as Array<{ id: string }>).map((row) => row.id),
		).toEqual(["root", "branch-a", "leaf-a"]);
	});

	it("routes auth init and complete by provider restrictions", async () => {
		const { router, dbOps } = createRouterContext();

		const anthropicInitResponse = await apiRequest(
			router,
			"POST",
			"/api/auth/anthropic/init",
			{
				name: "anthropic-account",
			},
		);
		expect(anthropicInitResponse.status).toBe(400);
		expect((await anthropicInitResponse.json()) as { error: string }).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("does not support auth flows"),
			}),
		);

		const openAiInitResponse = await apiRequest(
			router,
			"POST",
			"/api/auth/claude-code/init",
			{
				name: "claude-code-oauth-account",
			},
		);
		expect(openAiInitResponse.status).toBe(200);

		const openAiInitBody = (await openAiInitResponse.json()) as {
			data: { authUrl: string; sessionId: string };
		};
		expect(openAiInitBody.data.authUrl).toContain("https://claude.ai");
		expect(
			new URL(openAiInitBody.data.authUrl).searchParams.get("redirect_uri"),
		).toBe("https://platform.claude.com/oauth/code/callback");
		expect(dbOps.getAuthSession(openAiInitBody.data.sessionId)).toEqual(
			expect.objectContaining({
				provider: "claude-code",
				authMethod: "oauth",
				accountName: "claude-code-oauth-account",
			}),
		);

		const codexInitResponse = await apiRequest(
			router,
			"POST",
			"/api/auth/codex/init",
			{
				name: "codex-oauth-account",
			},
		);
		expect(codexInitResponse.status).toBe(200);

		const codexInitBody = (await codexInitResponse.json()) as {
			data: { authUrl: string; sessionId: string };
		};
		expect(codexInitBody.data.authUrl).toContain("https://auth.openai.com");
		expect(
			new URL(codexInitBody.data.authUrl).searchParams.get("client_id"),
		).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(
			new URL(codexInitBody.data.authUrl).searchParams.get("redirect_uri"),
		).toBe("http://localhost:1455/auth/callback");
		expect(dbOps.getAuthSession(codexInitBody.data.sessionId)).toEqual(
			expect.objectContaining({
				provider: "codex",
				authMethod: "oauth",
				accountName: "codex-oauth-account",
			}),
		);

		const completeResponse = await apiRequest(
			router,
			"POST",
			"/api/auth/codex/complete",
			{
				sessionId: crypto.randomUUID(),
				code: "fake-code",
			},
		);
		expect(completeResponse.status).toBe(400);
		expect((await completeResponse.json()) as { error: string }).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("session expired or invalid"),
			}),
		);

		const unknownProvider = await apiRequest(
			router,
			"POST",
			"/api/auth/gemini/init",
			{
				name: "unsupported-account",
			},
		);
		expect([400, 404]).toContain(unknownProvider.status);
	});

	it("auto-completes Codex through the shared localhost OAuth loopback", async () => {
		const { router, dbOps } = createRouterContext();
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).startsWith("http://127.0.0.1:1455/")) {
					return originalFetch(input, init);
				}
				return Response.json({
					access_token: "codex-loopback-access",
					refresh_token: "codex-loopback-refresh",
					expires_in: 3600,
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const codexInitResponse = await apiRequest(
			router,
			"POST",
			"/api/auth/codex/init",
			{
				name: "codex-forwarder-account",
			},
		);
		expect(codexInitResponse.status).toBe(200);

		const codexInitBody = (await codexInitResponse.json()) as {
			data: { authUrl: string };
		};
		const codexState = new URL(codexInitBody.data.authUrl).searchParams.get(
			"state",
		);
		expect(codexState).toBeTruthy();

		const codexForwardResponse = await fetch(
			`http://127.0.0.1:1455/auth/callback?code=codex-code&state=${codexState}&foo=bar`,
			{
				redirect: "manual",
			},
		);
		expect(codexForwardResponse.status).toBe(200);
		expect(await codexForwardResponse.text()).toContain("Account connected");
		expect(dbOps.getAccountByName("codex-forwarder-account")).toMatchObject({
			access_token: "codex-loopback-access",
		});
	});

	it("auto-completes OAuth callbacks via state lookup and reports completed session status", async () => {
		const { router, dbOps } = createRouterContext();

		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				expect(request.url).toBe("https://auth.openai.com/oauth/token");
				expect(await request.text()).toContain("code=callback-code");

				return new Response(
					JSON.stringify({
						access_token: "callback-access-token",
						refresh_token: "callback-refresh-token",
						expires_in: 3600,
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					},
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const initResponse = await apiRequest(
			router,
			"POST",
			"/api/auth/codex/init",
			{
				name: "callback-account",
			},
		);
		expect(initResponse.status).toBe(200);

		const initBody = (await initResponse.json()) as {
			data: { authUrl: string; sessionId: string };
		};
		const state = new URL(initBody.data.authUrl).searchParams.get("state");
		expect(state).toBeTruthy();

		const pendingStatusResponse = await apiRequest(
			router,
			"GET",
			`/api/auth/session/${initBody.data.sessionId}/status`,
		);
		expect(pendingStatusResponse.status).toBe(200);
		expect((await pendingStatusResponse.json()) as { status: string }).toEqual({
			status: "pending",
		});

		const callbackResponse = await router.handleRequest(
			new URL(
				`http://localhost:8080/oauth/codex/callback?code=callback-code&state=${state}`,
			),
			new Request(
				`http://localhost:8080/oauth/codex/callback?code=callback-code&state=${state}`,
			),
		);
		expect(callbackResponse).not.toBeNull();
		expect(callbackResponse?.status).toBe(200);
		expect(callbackResponse?.headers.get("content-type")).toContain(
			"text/html",
		);
		expect(await (callbackResponse as Response).text()).toContain(
			"Account connected",
		);

		const completedStatusResponse = await apiRequest(
			router,
			"GET",
			`/api/auth/session/${initBody.data.sessionId}/status`,
		);
		expect(completedStatusResponse.status).toBe(200);
		expect(
			(await completedStatusResponse.json()) as { status: string },
		).toEqual({ status: "completed" });

		expect(dbOps.getAllAccounts()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "callback-account",
					provider: "codex",
					auth_method: "oauth",
				}),
			]),
		);

		const expiredStatusResponse = await apiRequest(
			router,
			"GET",
			`/api/auth/session/${crypto.randomUUID()}/status`,
		);
		expect(expiredStatusResponse.status).toBe(200);
		expect((await expiredStatusResponse.json()) as { status: string }).toEqual({
			status: "expired",
		});
	});

	it("returns an HTML error page when an OAuth callback state is invalid", async () => {
		const router = createRouter();

		const response = await router.handleRequest(
			new URL(
				"http://localhost:8080/oauth/codex/callback?code=bad-code&state=missing-state",
			),
			new Request(
				"http://localhost:8080/oauth/codex/callback?code=bad-code&state=missing-state",
			),
		);

		expect(response).not.toBeNull();
		expect(response?.status).toBe(400);
		expect(response?.headers.get("content-type")).toContain("text/html");
		expect(await (response as Response).text()).toContain(
			"Authorization failed",
		);
	});

	it("returns an SSE response for log streaming", async () => {
		const router = createRouter();
		const response = await apiRequest(router, "GET", "/api/logs/stream");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
	});
});
