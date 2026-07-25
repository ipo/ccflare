import { describe, expect, it } from "bun:test";
import type { Account, AccountProvider, RequestMeta } from "@ccflare/types";
import { selectAccountsForRequest } from "./account-selector";
import type { ResolvedProxyContext } from "./proxy-types";

function createAccount(
	id: string,
	name: string,
	provider: AccountProvider,
): Account {
	return {
		id,
		name,
		provider,
		auth_method: "api_key",
		base_url: null,
		api_key: null,
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

describe("selectAccountsForRequest", () => {
	it("filters accounts using the resolved provider name", () => {
		const seenProviders: string[][] = [];
		const meta: RequestMeta = {
			id: "request-1",
			method: "POST",
			path: "/v1/openai/responses",
			timestamp: Date.now(),
		};
		const ctx = {
			providerName: "openai",
			strategy: {
				select(accounts: Account[]) {
					seenProviders.push(accounts.map((account) => account.provider));
					return accounts;
				},
			},
			dbOps: {
				getAvailableAccountsByProvider(provider: AccountProvider) {
					return [
						createAccount("a1", "anthropic-account", "anthropic"),
						createAccount("o1", "openai-account", "openai"),
					].filter((account) => account.provider === provider);
				},
			},
		} as unknown as ResolvedProxyContext;

		const selected = selectAccountsForRequest(meta, ctx);

		expect(seenProviders).toEqual([["openai"]]);
		expect(selected.map((account) => account.name)).toEqual(["openai-account"]);
	});

	it("includes rate-limited accounts only for separately metered models", () => {
		const seenOptions: Array<{ includeRateLimited?: boolean } | undefined> = [];
		const meta: RequestMeta = {
			id: "request-2",
			method: "POST",
			path: "/v1/ccflare/openai/responses",
			timestamp: Date.now(),
		};
		const ctx = {
			providerName: "codex",
			strategy: {
				select(accounts: Account[]) {
					return accounts;
				},
			},
			dbOps: {
				getAvailableAccountsByProvider(
					_provider: AccountProvider,
					options?: { includeRateLimited?: boolean },
				) {
					seenOptions.push(options);
					return [];
				},
			},
		} as unknown as ResolvedProxyContext;

		selectAccountsForRequest(meta, ctx, "gpt-5.3-codex-spark");
		selectAccountsForRequest(meta, ctx, "gpt-5.5");
		selectAccountsForRequest(meta, ctx);

		expect(seenOptions).toEqual([
			{ includeRateLimited: true },
			{ includeRateLimited: false },
			{ includeRateLimited: false },
		]);
	});
});
