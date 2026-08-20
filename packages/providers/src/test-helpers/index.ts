import { expect } from "bun:test";
import type { Account, ApiKeyProvider, OAuthProvider } from "@ccflare/types";
import type { Provider } from "../types";

export const originalFetch = globalThis.fetch;

type FetchCallback = (request: Request) => void | Promise<void>;

function getTokenLabel(provider: ApiKeyProvider | OAuthProvider): string {
	switch (provider) {
		case "anthropic":
			return "ant";
		case "claude-code":
			return "claude";
		default:
			return provider;
	}
}

export function createApiKeyAccount(
	provider: ApiKeyProvider,
	overrides: Partial<Account> = {},
): Account {
	const tokenLabel = getTokenLabel(provider);
	return {
		id: "account-1",
		name: `${provider}-test`,
		provider,
		auth_method: "api_key",
		base_url: null,
		api_key: `sk-${tokenLabel}-test`,
		refresh_token: null,
		access_token: null,
		oauth_subject: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		weight: 1,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		...overrides,
	};
}

export function createOAuthAccount(
	provider: OAuthProvider,
	overrides: Partial<Account> = {},
): Account {
	const tokenLabel = getTokenLabel(provider);
	return {
		id: "account-1",
		name: `${provider}-test`,
		provider,
		auth_method: "oauth",
		base_url: null,
		api_key: null,
		refresh_token: `${tokenLabel}-refresh-token`,
		access_token: `${tokenLabel}-access-token`,
		oauth_subject: provider === "grok" ? "grok-user-subject" : null,
		expires_at: Date.now() + 60_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		weight: 1,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		...overrides,
	};
}

export function createJsonFetchMock(
	payload: unknown,
	onRequest?: FetchCallback,
	init: ResponseInit = {},
): typeof fetch {
	return Object.assign(
		async (input: RequestInfo | URL, requestInit?: RequestInit) => {
			const request = new Request(input, requestInit);
			await onRequest?.(request);

			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: {
					"content-type": "application/json",
				},
				...init,
			});
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
}

export function expectBuildUrlCases(
	provider: Provider,
	cases: Array<{
		upstreamPath: string;
		query?: string;
		account?: Account;
		expected: string;
	}>,
): void {
	for (const testCase of cases) {
		expect(
			provider.buildUrl(
				testCase.upstreamPath,
				testCase.query ?? "",
				testCase.account,
			),
		).toBe(testCase.expected);
	}
}

export function expectRemovedHeaders(headers: Headers, names: string[]): void {
	for (const name of names) {
		expect(headers.get(name)).toBeNull();
	}
}

export function expectUnifiedRateLimit(
	provider: Provider,
	response: Response,
	expected: {
		isRateLimited: boolean;
		resetTime: number;
		statusHeader: string;
		remaining?: number;
	},
): void {
	expect(provider.parseRateLimit(response)).toEqual(expected);
}

export function expectNoOAuthSupport(provider: object): void {
	expect("refreshToken" in provider).toBe(false);
	expect("getOAuthProvider" in provider).toBe(false);
}
