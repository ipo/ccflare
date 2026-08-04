import {
	type Account,
	getAccountRateLimitInfo,
	getAccountSessionInfo,
	getAccountTokenStatus,
} from "@ccflare/types";
import type { AccountQuotaSnapshot, AccountResponse } from "../types";

export function serializeAccount(
	account: Account,
	now: number = Date.now(),
	quota: AccountQuotaSnapshot | null = null,
): AccountResponse {
	const rateLimit = getAccountRateLimitInfo(account, now);
	const session = getAccountSessionInfo(account);

	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		auth_method: account.auth_method,
		base_url: account.base_url,
		requestCount: account.request_count,
		totalRequests: account.total_requests,
		lastUsed: account.last_used
			? new Date(account.last_used).toISOString()
			: null,
		created: new Date(account.created_at).toISOString(),
		weight: account.weight,
		paused: account.paused,
		tokenStatus: getAccountTokenStatus(account, now),
		tokenExpiresAt: account.expires_at
			? new Date(account.expires_at).toISOString()
			: null,
		rateLimitStatus: {
			code: rateLimit.code,
			isLimited: rateLimit.isLimited,
			until: rateLimit.until ? new Date(rateLimit.until).toISOString() : null,
		},
		rateLimitReset: rateLimit.resetAt
			? new Date(rateLimit.resetAt).toISOString()
			: null,
		rateLimitRemaining: rateLimit.remaining,
		sessionInfo: {
			active: session.active,
			startedAt: session.startedAt
				? new Date(session.startedAt).toISOString()
				: null,
			requestCount: session.requestCount,
		},
		quota,
	};
}
