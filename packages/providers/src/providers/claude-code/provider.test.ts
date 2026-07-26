import { afterEach, describe, expect, it } from "bun:test";
import {
	createJsonFetchMock,
	createOAuthAccount,
	expectBuildUrlCases,
	expectRemovedHeaders,
	expectUnifiedRateLimit,
	originalFetch,
} from "../../test-helpers";
import { ClaudeCodeProvider } from "./provider";

function createQuotaFetchMock(
	handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
	return Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) =>
			handler(new Request(input, init)),
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
}

describe("ClaudeCodeProvider", () => {
	const provider = new ClaudeCodeProvider();

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("builds upstream URLs from the stripped Claude Code path", () => {
		expectBuildUrlCases(provider, [
			{
				upstreamPath: "/v1/messages",
				expected: "https://api.anthropic.com/v1/messages",
			},
			{
				upstreamPath: "/v1/models",
				query: "?foo=bar",
				expected: "https://api.anthropic.com/v1/models?foo=bar",
			},
			{
				upstreamPath: "/v1/messages",
				account: createOAuthAccount("claude-code", {
					base_url: "https://anthropic.internal/",
				}),
				expected: "https://anthropic.internal/v1/messages",
			},
		]);
	});

	it("injects Authorization: Bearer and never x-api-key", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
				"x-api-key": "client-supplied-key",
				"accept-encoding": "gzip",
				"content-encoding": "gzip",
				"x-ccflare-session-id": "session-xyz",
			}),
			createOAuthAccount("claude-code"),
		);

		expect(headers.get("authorization")).toBe("Bearer claude-access-token");
		expectRemovedHeaders(headers, [
			"x-api-key",
			"host",
			"accept-encoding",
			"content-encoding",
			"x-ccflare-session-id",
		]);
	});

	it("refreshes OAuth tokens via platform.claude.com", async () => {
		let requestUrl = "";
		let requestBody = "";

		globalThis.fetch = createJsonFetchMock(
			{
				access_token: "fresh-claude-access-token",
				refresh_token: "fresh-claude-refresh-token",
				expires_in: 1800,
			},
			async (request) => {
				requestUrl = request.url;
				requestBody = await request.text();
			},
		);

		const refreshed = await provider.refreshToken(
			createOAuthAccount("claude-code"),
			"test-client-id",
		);

		expect(requestUrl).toBe("https://platform.claude.com/v1/oauth/token");
		expect(requestBody).toContain('"grant_type":"refresh_token"');
		expect(requestBody).toContain('"refresh_token":"claude-refresh-token"');
		expect(requestBody).toContain('"client_id":"test-client-id"');
		expect(refreshed).toEqual({
			accessToken: "fresh-claude-access-token",
			refreshToken: "fresh-claude-refresh-token",
			expiresAt: expect.any(Number),
		});
	});

	it("collects Claude Code usage and profile quota data without leaking secrets", async () => {
		const requests: Request[] = [];
		const fetchFn = createQuotaFetchMock((request) => {
			requests.push(request);
			const data = request.url.endsWith("/usage")
				? {
						five_hour: { utilization: 12 },
						token_count: 42,
						access_token: "must-not-leak",
						note: "rejected claude-access-token",
					}
				: {
						subscription_type: "max",
						refreshToken: "must-not-leak-either",
					};
			return Response.json(data);
		});

		const report = await provider.fetchQuota(
			createOAuthAccount("claude-code"),
			fetchFn,
		);

		expect(report.state).toBe("ok");
		expect(requests.map((request) => request.url)).toEqual([
			"https://api.anthropic.com/api/oauth/usage",
			"https://api.anthropic.com/api/oauth/profile",
		]);
		for (const request of requests) {
			expect(request.headers.get("authorization")).toBe(
				"Bearer claude-access-token",
			);
			expect(request.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
			expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
			expect(request.headers.get("user-agent")).toContain("claude-cli/");
		}
		expect(report.sources.usage.data).toEqual({
			five_hour: { utilization: 12 },
			token_count: 42,
			access_token: "[REDACTED]",
			note: "rejected [REDACTED]",
		});
		expect(JSON.stringify(report)).not.toContain("must-not-leak");
	});

	it("retains successful Claude Code quota sources when another probe fails", async () => {
		const fetchFn = createQuotaFetchMock((request) =>
			request.url.endsWith("/profile")
				? Response.json({ error: "temporarily unavailable" }, { status: 503 })
				: Response.json({ five_hour: { utilization: 20 } }),
		);

		const report = await provider.fetchQuota(
			createOAuthAccount("claude-code"),
			fetchFn,
		);

		expect(report.state).toBe("partial");
		expect(report.sources.usage.state).toBe("ok");
		expect(report.sources.profile).toEqual({
			state: "failed",
			status: 503,
			data: { error: "temporarily unavailable" },
			error: "Upstream quota request failed with HTTP 503",
		});
	});

	it("parses Anthropic unified rate limit headers", () => {
		const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-reset": String(resetSeconds),
				"anthropic-ratelimit-unified-remaining": "17",
			},
		});

		expectUnifiedRateLimit(provider, response, {
			isRateLimited: false,
			resetTime: resetSeconds * 1000,
			statusHeader: "allowed",
			remaining: 17,
		});
	});
});
