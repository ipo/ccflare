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
import type { Provider, ProviderQuotaReport } from "@ccflare/providers";
import { sanitizeQuotaData } from "@ccflare/providers";
import type { Account, AccountProvider } from "@ccflare/types";
import type { AccountQuotaResponse } from "../types";
import {
	createAccountCredentialRefresher,
	needsTokenRefresh,
} from "./account-credentials";

const log = new Logger("AccountQuotaHandler");
const QUOTA_PROVIDERS = new Set<AccountProvider>([
	"claude-code",
	"codex",
	"kimi",
]);

function hasUnauthorizedSource(report: ProviderQuotaReport): boolean {
	return Object.values(report.sources).some((source) => source.status === 401);
}

/**
 * Best-effort check: does a successful quota report prove the account
 * currently has quota available? Any parsing problem or unexpected shape
 * returns false, meaning "don't touch anything".
 */
export function quotaIndicatesAvailability(
	provider: AccountProvider,
	report: ProviderQuotaReport,
): boolean {
	try {
		if (report.state === "failed") return false;
		const usage = report.sources?.usage;
		if (!usage || usage.state !== "ok") return false;
		const data = usage.data;
		if (typeof data !== "object" || data === null) return false;
		const d = data as Record<string, unknown>;

		if (provider === "codex") {
			const rl = d.rate_limit as
				| { allowed?: unknown; limit_reached?: unknown }
				| undefined;
			return rl?.allowed === true && rl?.limit_reached === false;
		}

		if (provider === "claude-code") {
			// Every window that reports a numeric utilization must have
			// headroom; unknown windows are ignored.
			const windows = [
				d.five_hour,
				d.seven_day,
				d.seven_day_opus,
				d.seven_day_sonnet,
			]
				.filter(
					(w): w is { utilization?: unknown } =>
						typeof w === "object" && w !== null,
				)
				.filter((w) => typeof w.utilization === "number");
			if (windows.length === 0) return false;
			return windows.every((w) => (w.utilization as number) < 100);
		}

		if (provider === "kimi") {
			const summary = d.usage as
				| { limit?: unknown; used?: unknown }
				| undefined;
			const limit = Number(summary?.limit);
			const used = Number(summary?.used);
			if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) {
				return false;
			}
			if (used >= limit) return false;
			// Per-window details must also have headroom when present.
			const details = Array.isArray(d.limits) ? d.limits : [];
			for (const w of details) {
				const det = (w as { detail?: { limit?: unknown; used?: unknown } })
					?.detail;
				if (!det) continue;
				const l2 = Number(det.limit);
				const u2 = Number(det.used);
				if (Number.isFinite(l2) && l2 > 0 && Number.isFinite(u2) && u2 >= l2) {
					return false;
				}
			}
			return true;
		}

		return false;
	} catch {
		return false;
	}
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

/**
 * Fetch quota for one selected account without involving load balancing.
 */
export function createAccountQuotaHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getProvider: (provider: AccountProvider) => Provider | undefined,
) {
	const refreshAccount = createAccountCredentialRefresher(dbOps, config);

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

			// If the live quota proves the account has headroom while the
			// database still considers it rate-limited (stale header-derived
			// flag, e.g. provider-side quota reset), clear the stale flag so
			// account selection unblocks. Fail-open: any error here must not
			// affect the quota response.
			try {
				if (
					account.rate_limited_until &&
					account.rate_limited_until > Date.now() &&
					quotaIndicatesAvailability(account.provider, report)
				) {
					dbOps.clearAccountRateLimit(account.id);
					log.info(
						`Cleared stale rate-limit flag for account ${account.id} (${account.provider}): quota reports availability`,
					);
				}
			} catch (clearError) {
				log.warn(
					`Failed to clear stale rate-limit flag for account ${account.id}`,
					clearError instanceof Error ? clearError.name : "Unknown failure",
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
