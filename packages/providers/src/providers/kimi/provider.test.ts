import { afterEach, describe, expect, it } from "bun:test";
import type { Account } from "@ccflare/types";
import { KIMI_OAUTH_CLIENT_ID, KIMI_OAUTH_TOKEN_URL } from "./oauth";
import { KimiProvider } from "./provider";

const originalFetch = globalThis.fetch;

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "kimi-account",
		name: "kimi",
		provider: "kimi",
		api_key: null,
		refresh_token: "stored-refresh",
		access_token: "stored-access",
		expires_at: Date.now() + 900_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		account_tier: 1,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		auth_method: "oauth",
		base_url: null,
		...overrides,
	} as Account;
}

function createQuotaFetchMock(
	handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
	return Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) =>
			handler(new Request(input, init)),
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("KimiProvider", () => {
	it("builds upstream URLs from the stripped Kimi path", () => {
		const provider = new KimiProvider();
		expect(provider.buildUrl("/chat/completions", "")).toBe(
			"https://api.kimi.com/coding/v1/chat/completions",
		);
	});

	it("sets Bearer auth and strips Anthropic-family headers", () => {
		const provider = new KimiProvider();
		const headers = provider.prepareHeaders(
			new Headers({
				"x-api-key": "leftover",
				"anthropic-version": "2023-06-01",
				"x-ccflare-session-id": "session-xyz",
				host: "localhost:8080",
			}),
			account(),
		);

		expect(headers.get("Authorization")).toBe("Bearer stored-access");
		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("anthropic-version")).toBeNull();
		expect(headers.get("host")).toBeNull();
		expect(headers.get("x-ccflare-session-id")).toBeNull();
	});

	it("refreshes with the device-flow client id and honors token rotation", async () => {
		const provider = new KimiProvider();
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				expect(request.url).toBe(KIMI_OAUTH_TOKEN_URL);
				const body = await request.text();
				expect(body).toContain("grant_type=refresh_token");
				expect(body).toContain("refresh_token=stored-refresh");
				expect(body).toContain(`client_id=${KIMI_OAUTH_CLIENT_ID}`);

				return new Response(
					JSON.stringify({
						access_token: "new-access",
						refresh_token: "rotated-refresh",
						expires_in: 900,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const result = await provider.refreshToken(account(), "ignored-client-id");

		expect(result.accessToken).toBe("new-access");
		expect(result.refreshToken).toBe("rotated-refresh");
		expect(result.expiresAt).toBeGreaterThan(Date.now());
	});

	it("collects Kimi quota from /usages and redacts credential-shaped fields", async () => {
		const provider = new KimiProvider();
		const requests: Request[] = [];
		const fetchFn = createQuotaFetchMock((request) => {
			requests.push(request);
			return Response.json({
				usage: { name: "Weekly limit", used: 40, limit: 1000 },
				limits: [{ detail: { name: "5h limit", used: 1, limit: 100 } }],
				access_token: "must-not-leak",
			});
		});

		const report = await provider.fetchQuota(account(), fetchFn);

		expect(report.state).toBe("ok");
		expect(requests.map((request) => request.url)).toEqual([
			"https://api.kimi.com/coding/v1/usages",
		]);
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer stored-access",
		);
		expect(requests[0].headers.get("accept")).toBe("application/json");
		expect(report.sources.usage.data).toEqual({
			usage: { name: "Weekly limit", used: 40, limit: 1000 },
			limits: [{ detail: { name: "5h limit", used: 1, limit: 100 } }],
			access_token: "[REDACTED]",
		});
		expect(report.windows).toEqual([
			expect.objectContaining({
				id: "kimi:account:summary:7d",
				period: "7d",
				usedPercent: 4,
			}),
			expect.objectContaining({
				id: "kimi:account:5h-limit:5h",
				period: "5h",
				usedPercent: 1,
			}),
		]);
		expect(JSON.stringify(report)).not.toContain("must-not-leak");
		expect(JSON.stringify(report)).not.toContain("stored-access");
	});

	it("uses the account's custom base URL for the Kimi usage probe", async () => {
		const provider = new KimiProvider();
		const requests: Request[] = [];
		const fetchFn = createQuotaFetchMock((request) => {
			requests.push(request);
			return Response.json({ usage: { used: 0, limit: 100 } });
		});

		const report = await provider.fetchQuota(
			account({ base_url: "https://kimi.internal/coding/v1/" }),
			fetchFn,
		);

		expect(report.state).toBe("ok");
		expect(requests[0].url).toBe("https://kimi.internal/coding/v1/usages");
	});

	it("reports a failed Kimi quota probe without discarding the error detail", async () => {
		const provider = new KimiProvider();
		const fetchFn = createQuotaFetchMock(() =>
			Response.json({ error: "invalid token" }, { status: 401 }),
		);

		const report = await provider.fetchQuota(account(), fetchFn);

		expect(report.state).toBe("failed");
		expect(report.sources.usage).toEqual(
			expect.objectContaining({ state: "failed", status: 401 }),
		);
	});

	it("rejects quota fetching without an access token", async () => {
		const provider = new KimiProvider();

		await expect(
			provider.fetchQuota(account({ access_token: null })),
		).rejects.toThrow("No access token available for Kimi account");
	});

	it("keeps the stored refresh token when the server omits a new one", async () => {
		const provider = new KimiProvider();
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({ access_token: "new-access", expires_in: 900 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const result = await provider.refreshToken(account(), "ignored-client-id");

		expect(result.refreshToken).toBe("stored-refresh");
	});
});
