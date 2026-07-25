import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import type { Provider, TokenRefreshResult } from "@ccflare/providers";
import type { Account } from "@ccflare/types";

const TOKEN_SAFETY_WINDOW_MS = 30_000;

export function needsTokenRefresh(account: Account, now = Date.now()): boolean {
	return (
		!account.access_token ||
		account.expires_at === null ||
		account.expires_at - now <= TOKEN_SAFETY_WINDOW_MS
	);
}

function validateRefreshedTokens(result: TokenRefreshResult): void {
	if (
		!result.accessToken ||
		!Number.isFinite(result.expiresAt) ||
		result.expiresAt <= Date.now()
	) {
		throw new Error("Provider returned invalid refreshed OAuth credentials");
	}
}

/**
 * Shared OAuth credential refresher for per-account management endpoints.
 * Concurrent refreshes for the same account are deduplicated and rotated
 * tokens are persisted before the refreshed account is returned.
 */
export function createAccountCredentialRefresher(
	dbOps: DatabaseOperations,
	config: Config,
) {
	const refreshInFlight = new Map<string, Promise<Account>>();

	return function refreshAccount(
		account: Account,
		provider: Provider,
	): Promise<Account> {
		const existingRefresh = refreshInFlight.get(account.id);
		if (existingRefresh) {
			return existingRefresh;
		}

		if (!provider.refreshToken || !account.refresh_token) {
			throw new Error("No refresh token is available for this account");
		}

		const refresh = provider
			.refreshToken(account, config.getRuntime().clientId)
			.then((result) => {
				validateRefreshedTokens(result);
				dbOps.updateAccountTokens(
					account.id,
					result.accessToken,
					result.expiresAt,
					result.refreshToken || undefined,
				);

				const refreshedAccount = dbOps.getAccount(account.id);
				if (!refreshedAccount) {
					throw new Error("Account disappeared while refreshing credentials");
				}
				return refreshedAccount;
			})
			.finally(() => {
				refreshInFlight.delete(account.id);
			});

		refreshInFlight.set(account.id, refresh);
		return refresh;
	};
}
