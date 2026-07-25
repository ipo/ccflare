import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import {
	BadGateway,
	errorResponse,
	jsonResponse,
	NotFound,
	NotImplemented,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import type {
	Provider,
	ProviderQuotaReport,
	TokenRefreshResult,
} from "@ccflare/providers";
import { sanitizeQuotaData } from "@ccflare/providers";
import type { Account, AccountProvider } from "@ccflare/types";
import type { AccountQuotaResponse } from "../types";

const log = new Logger("AccountQuotaHandler");
const TOKEN_SAFETY_WINDOW_MS = 30_000;
const QUOTA_PROVIDERS = new Set<AccountProvider>([
	"claude-code",
	"codex",
	"kimi",
]);

function needsTokenRefresh(account: Account, now = Date.now()): boolean {
	return (
		!account.access_token ||
		account.expires_at === null ||
		account.expires_at - now <= TOKEN_SAFETY_WINDOW_MS
	);
}

function hasUnauthorizedSource(report: ProviderQuotaReport): boolean {
	return Object.values(report.sources).some((source) => source.status === 401);
}

function toQuotaResponse(
	account: Account,
	report: ProviderQuotaReport,
): AccountQuotaResponse {
	return {
		account: {
			id: account.id,
			name: account.name,
			provider: account.provider,
		},
		state: report.state,
		collectedAt: report.collectedAt,
		sources: sanitizeQuotaData(report.sources, [
			account.access_token ?? "",
			account.refresh_token ?? "",
		]) as AccountQuotaResponse["sources"],
	};
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
 * Fetch quota for one selected account without involving load balancing.
 */
export function createAccountQuotaHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getProvider: (provider: AccountProvider) => Provider | undefined,
) {
	const refreshInFlight = new Map<string, Promise<Account>>();

	async function refreshAccount(
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
	}

	return async (_req: Request, accountId: string): Promise<Response> => {
		let account = dbOps.getAccount(accountId);
		if (!account) {
			return errorResponse(NotFound("Account not found"));
		}

		if (!QUOTA_PROVIDERS.has(account.provider)) {
			return errorResponse(
				NotImplemented(
					`Quota checks are not implemented for provider '${account.provider}'`,
					{ provider: account.provider },
				),
			);
		}

		const provider = getProvider(account.provider);
		if (!provider?.fetchQuota) {
			return errorResponse(
				NotImplemented(
					`Quota checks are not implemented for provider '${account.provider}'`,
					{ provider: account.provider },
				),
			);
		}

		let refreshed = false;
		try {
			if (needsTokenRefresh(account)) {
				account = await refreshAccount(account, provider);
				refreshed = true;
			}

			let report = await provider.fetchQuota(account);
			if (
				!refreshed &&
				report.state === "failed" &&
				hasUnauthorizedSource(report)
			) {
				account = await refreshAccount(account, provider);
				report = await provider.fetchQuota(account);
			}

			const response = toQuotaResponse(account, report);
			if (report.state === "failed") {
				return errorResponse(
					BadGateway("All provider quota sources failed", response),
				);
			}

			return jsonResponse(response);
		} catch (error) {
			log.error(
				`Quota check failed for account ${account.id} (${account.provider})`,
				error instanceof Error ? error.name : "Unknown failure",
			);
			return errorResponse(
				BadGateway("Failed to fetch account quota", {
					account: {
						id: account.id,
						name: account.name,
						provider: account.provider,
					},
				}),
			);
		}
	};
}
