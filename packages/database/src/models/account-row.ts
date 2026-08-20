import type { Account, AccountProvider, AuthMethod } from "@ccflare/types";

export interface AccountRow {
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
	created_at: number;
	last_used: number | null;
	request_count: number;
	total_requests: number;
	rate_limited_until?: number | null;
	session_start?: number | null;
	session_request_count?: number;
	weight: number;
	paused?: 0 | 1;
	rate_limit_reset?: number | null;
	rate_limit_status?: string | null;
	rate_limit_remaining?: number | null;
}

export function toAccount(row: AccountRow): Account {
	return {
		id: row.id,
		name: row.name,
		provider: row.provider,
		auth_method: row.auth_method,
		base_url: row.base_url,
		api_key: row.api_key,
		refresh_token: row.refresh_token,
		access_token: row.access_token,
		oauth_subject: row.oauth_subject ?? null,
		expires_at: row.expires_at,
		created_at: row.created_at,
		last_used: row.last_used,
		request_count: row.request_count,
		total_requests: row.total_requests,
		rate_limited_until: row.rate_limited_until ?? null,
		session_start: row.session_start ?? null,
		session_request_count: row.session_request_count ?? 0,
		weight: row.weight || 1,
		paused: row.paused === 1,
		rate_limit_reset: row.rate_limit_reset ?? null,
		rate_limit_status: row.rate_limit_status ?? null,
		rate_limit_remaining: row.rate_limit_remaining ?? null,
	};
}
