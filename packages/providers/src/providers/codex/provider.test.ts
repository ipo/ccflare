import { afterEach, describe, expect, it } from "bun:test";
import {
	createJsonFetchMock,
	createOAuthAccount,
	expectBuildUrlCases,
	expectRemovedHeaders,
	expectUnifiedRateLimit,
	originalFetch,
} from "../../test-helpers";
import { CodexProvider } from "./provider";

describe("CodexProvider", () => {
	const provider = new CodexProvider();

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("builds backend-api URLs from the stripped Codex path", () => {
		expectBuildUrlCases(provider, [
			{
				upstreamPath: "/responses",
				expected: "https://chatgpt.com/backend-api/codex/responses",
			},
			{
				upstreamPath: "/responses",
				query: "?stream=true",
				expected: "https://chatgpt.com/backend-api/codex/responses?stream=true",
			},
			{
				upstreamPath: "/tasks",
				account: createOAuthAccount("codex", {
					base_url: "https://chatgpt.internal/backend-api/codex/",
				}),
				expected: "https://chatgpt.internal/backend-api/codex/tasks",
			},
		]);
	});

	it("injects Bearer auth plus Codex headers", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
				"x-api-key": "client-supplied-key",
				"anthropic-version": "2023-06-01",
				"accept-encoding": "gzip",
				"content-encoding": "gzip",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("authorization")).toBe("Bearer codex-access-token");
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("version")).toBe("0.144.1");
		expect(headers.get("user-agent")).toContain("codex_cli_rs/0.144.1");
		expect(headers.get("user-agent")).toContain("arm64");
		expectRemovedHeaders(headers, [
			"x-api-key",
			"anthropic-version",
			"host",
			"accept-encoding",
			"content-encoding",
		]);
	});

	it("refreshes OAuth tokens via auth.openai.com with rotating refresh tokens", async () => {
		let requestUrl = "";
		let requestBody = "";

		globalThis.fetch = createJsonFetchMock(
			{
				access_token: "fresh-codex-access-token",
				refresh_token: "fresh-codex-refresh-token",
				expires_in: 1800,
			},
			async (request) => {
				requestUrl = request.url;
				requestBody = await request.text();
			},
		);

		const refreshed = await provider.refreshToken(
			createOAuthAccount("codex"),
			"unused-client-id",
		);

		expect(requestUrl).toBe("https://auth.openai.com/oauth/token");
		expect(requestBody).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
		expect(requestBody).toContain("refresh_token=codex-refresh-token");
		expect(refreshed).toEqual({
			accessToken: "fresh-codex-access-token",
			refreshToken: "fresh-codex-refresh-token",
			expiresAt: expect.any(Number),
		});
	});

	it("parses Codex rate limit headers", () => {
		const fiveHourReset = Math.floor((Date.now() + 60_000) / 1000);
		const sevenDayReset = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"x-codex-5h-reset-at": String(fiveHourReset),
				"x-codex-7d-reset-at": String(sevenDayReset),
				"x-codex-primary-used-percent": "12",
				"x-codex-secondary-used-percent": "4",
			},
		});

		expectUnifiedRateLimit(provider, response, {
			isRateLimited: false,
			resetTime: fiveHourReset * 1000,
			statusHeader: "allowed",
			remaining: undefined,
		});
	});
});
