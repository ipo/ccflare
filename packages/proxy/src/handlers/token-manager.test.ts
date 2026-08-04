import { describe, expect, it } from "bun:test";
import { AnthropicProvider, OpenAIProvider } from "@ccflare/providers";
import type { Account, ApiKeyProvider } from "@ccflare/types";
import type { ResolvedProxyContext } from "./proxy-types";
import { getValidAccessToken } from "./token-manager";

function apiKeyAccount(provider: ApiKeyProvider): Account {
	return {
		id: `${provider}-account`,
		name: `${provider}-account`,
		provider,
		auth_method: "api_key",
		base_url: null,
		api_key: `${provider}-secret-key`,
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

describe("token manager", () => {
	it("bypasses the OAuth manager for Anthropic and OpenAI API keys", async () => {
		let managerCalls = 0;
		for (const provider of [new AnthropicProvider(), new OpenAIProvider()]) {
			const account = apiKeyAccount(provider.name as ApiKeyProvider);
			const ctx = {
				provider,
				credentialManager: {
					async getValidAccount() {
						managerCalls++;
						throw new Error("OAuth manager must not be used");
					},
					async refreshAfterUnauthorized() {
						managerCalls++;
						throw new Error("OAuth manager must not be used");
					},
				},
			} as unknown as ResolvedProxyContext;

			expect(await getValidAccessToken(account, ctx)).toBe("");
			const headers = provider.prepareHeaders(new Headers(), account);
			if (provider.name === "anthropic") {
				expect(headers.get("x-api-key")).toBe("anthropic-secret-key");
			} else {
				expect(headers.get("authorization")).toBe("Bearer openai-secret-key");
			}
		}
		expect(managerCalls).toBe(0);
	});
});
