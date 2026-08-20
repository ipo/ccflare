import type { AccountProvider, AuthMethod } from "./provider-metadata";

export interface AccountRateLimitInfo {
	code: string;
	isLimited: boolean;
	until: number | null;
	resetAt: number | null;
	remaining: number | null;
}

export interface AccountSessionInfo {
	active: boolean;
	startedAt: number | null;
	requestCount: number;
}

// Domain model - used throughout the application
export interface Account {
	id: string;
	name: string;
	provider: AccountProvider;
	auth_method: AuthMethod;
	base_url: string | null;
	api_key: string | null;
	refresh_token: string | null;
	access_token: string | null;
	oauth_subject?: string | null;
	expires_at: number | null;
	request_count: number;
	total_requests: number;
	last_used: number | null;
	created_at: number;
	rate_limited_until: number | null;
	session_start: number | null;
	session_request_count: number;
	weight: number;
	paused: boolean;
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limit_remaining: number | null;
}

/**
 * Runtime-wide controller for OAuth access-token refreshes.
 *
 * Implementations must serialize provider refreshes per account and persist
 * replacement credentials before resolving either operation.
 */
export interface AccountCredentialManager {
	getValidAccount(account: Account, signal?: AbortSignal): Promise<Account>;
	refreshAfterUnauthorized(
		account: Account,
		rejectedAccessToken: string,
		signal?: AbortSignal,
	): Promise<Account>;
}

// Account creation types
export interface AddAccountOptions {
	name: string;
	provider: AccountProvider;
}

export interface AccountDeleteRequest {
	confirm: string;
}

function normalizeRateLimitCode(account: Account, now: number): string {
	if (account.paused) {
		return "paused";
	}

	if (account.rate_limit_status) {
		return account.rate_limit_status;
	}

	if (account.rate_limited_until && account.rate_limited_until > now) {
		return "rate_limited";
	}

	return "ok";
}

export function getAccountRateLimitInfo(
	account: Account,
	now: number = Date.now(),
): AccountRateLimitInfo {
	const limitedUntil =
		account.rate_limited_until && account.rate_limited_until > now
			? account.rate_limited_until
			: null;

	return {
		code: normalizeRateLimitCode(account, now),
		isLimited: account.paused ? false : limitedUntil !== null,
		until: limitedUntil,
		resetAt: account.rate_limit_reset ?? null,
		remaining: account.rate_limit_remaining ?? null,
	};
}

export function getAccountSessionInfo(account: Account): AccountSessionInfo {
	return {
		active: account.session_start !== null,
		startedAt: account.session_start ?? null,
		requestCount: account.session_request_count,
	};
}

export function getAccountTokenStatus(
	account: Pick<Account, "access_token" | "expires_at">,
	now: number = Date.now(),
): "valid" | "expired" {
	if (account.expires_at !== null) {
		return account.expires_at > now ? "valid" : "expired";
	}

	return account.access_token ? "valid" : "expired";
}
