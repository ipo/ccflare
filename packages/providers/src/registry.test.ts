import { describe, expect, it } from "bun:test";
import type { Account } from "@ccflare/types";
import {
	type Provider,
	ProviderRegistry,
	type RateLimitInfo,
	type TokenRefreshResult,
} from "./index";

function createTestProvider(name: string): Provider {
	return {
		name,
		defaultBaseUrl: `https://${name}.example.com`,
		async refreshToken(
			_account: Account,
			_clientId: string,
		): Promise<TokenRefreshResult> {
			throw new Error("not implemented");
		},
		buildUrl(upstreamPath: string, query: string, account?: Account): string {
			return `${account?.base_url ?? this.defaultBaseUrl}${upstreamPath}${query}`;
		},
		prepareHeaders(headers: Headers, _account: Account | null): Headers {
			return new Headers(headers);
		},
		parseRateLimit(): RateLimitInfo {
			return { isRateLimited: false };
		},
		buildProxyErrorResponse({ kind, message, retryAfterSeconds }) {
			const headers = new Headers({ "content-type": "application/json" });
			if (retryAfterSeconds !== undefined) {
				headers.set("retry-after", String(retryAfterSeconds));
			}
			return new Response(message, {
				status: kind === "rate_limit" ? 429 : 503,
				headers,
			});
		},
		async processResponse(response: Response): Promise<Response> {
			return response;
		},
	};
}

describe("ProviderRegistry", () => {
	it("registers multiple providers and resolves a valid Anthropic path", () => {
		const anthropic = createTestProvider("anthropic");
		const openai = createTestProvider("openai");
		const registry = new ProviderRegistry([anthropic, openai]);

		expect(registry.getProvider("anthropic")?.name).toBe("anthropic");
		expect(registry.getProvider("openai")?.name).toBe("openai");
		expect(registry.listProviders()).toEqual(["anthropic", "openai"]);
		expect(registry.resolveProvider("/v1/anthropic/v1/messages")).toEqual({
			provider: anthropic,
			upstreamPath: "/v1/messages",
			query: "",
		});
	});

	it("resolves a valid OpenAI path", () => {
		const openai = createTestProvider("openai");
		const registry = new ProviderRegistry([openai]);

		expect(registry.resolveProvider("/v1/openai/responses")).toEqual({
			provider: openai,
			upstreamPath: "/responses",
			query: "",
		});
	});

	it("returns null for an unknown provider", () => {
		const registry = new ProviderRegistry([createTestProvider("anthropic")]);

		expect(registry.resolveProvider("/v1/unknown/foo")).toBeNull();
	});

	it("returns null for a bare /v1/ path", () => {
		const registry = new ProviderRegistry([createTestProvider("anthropic")]);

		expect(registry.resolveProvider("/v1/")).toBeNull();
	});

	it("matches providers case-sensitively", () => {
		const registry = new ProviderRegistry([createTestProvider("anthropic")]);

		expect(registry.resolveProvider("/v1/Anthropic/v1/messages")).toBeNull();
	});

	it("strips the provider prefix exactly once", () => {
		const anthropic = createTestProvider("anthropic");
		const registry = new ProviderRegistry([anthropic]);

		expect(
			registry.resolveProvider("/v1/anthropic/v1/anthropic/v1/messages"),
		).toEqual({
			provider: anthropic,
			upstreamPath: "/v1/anthropic/v1/messages",
			query: "",
		});
	});
});
