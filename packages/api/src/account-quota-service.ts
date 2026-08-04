import type {
	DatabaseOperations,
	AccountQuotaSnapshot as StoredAccountQuotaSnapshot,
} from "@ccflare/database";
import { BadGateway, HttpError, NotFound, NotImplemented } from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import {
	normalizeQuotaWindows,
	type Provider,
	type ProviderQuotaReport,
	sanitizeQuotaData,
} from "@ccflare/providers";
import type {
	Account,
	AccountCredentialManager,
	AccountProvider,
} from "@ccflare/types";
import { credentialRefreshHttpError } from "./handlers/credential-errors";
import type {
	AccountQuotaRefresher,
	AccountQuotaResponse,
	AccountQuotaSnapshot,
	AccountQuotaWindow,
} from "./types";

const log = new Logger("AccountQuotaService");
const QUOTA_PROVIDERS = new Set<AccountProvider>([
	"claude-code",
	"codex",
	"kimi",
]);
const QUOTA_SHUTDOWN_GRACE_MS = 2_000;

function hasUnauthorizedSource(report: ProviderQuotaReport): boolean {
	return Object.values(report.sources).some((source) => source.status === 401);
}

function toQuotaResponse(
	account: Account,
	report: ProviderQuotaReport,
): AccountQuotaResponse {
	const windows = Array.isArray(report.windows)
		? report.windows
		: normalizeQuotaWindows(account.provider, report);
	return {
		account: {
			id: account.id,
			name: account.name,
			provider: account.provider,
		},
		state: report.state,
		collectedAt: report.collectedAt,
		windows,
		sources: sanitizeQuotaData(report.sources, [
			account.access_token ?? "",
			account.refresh_token ?? "",
		]) as AccountQuotaResponse["sources"],
	};
}

function failureMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function quotaFetchWithSignal(signal?: AbortSignal): typeof globalThis.fetch {
	if (!signal) return globalThis.fetch;
	return Object.assign(
		(input: RequestInfo | URL, init: RequestInit = {}) => {
			const requestSignal = init.signal
				? AbortSignal.any([signal, init.signal])
				: signal;
			return globalThis.fetch(input, { ...init, signal: requestSignal });
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as typeof globalThis.fetch;
}

function isQuotaWindow(value: unknown): value is AccountQuotaWindow {
	if (!value || typeof value !== "object") return false;
	const window = value as Record<string, unknown>;
	return (
		typeof window.id === "string" &&
		typeof window.label === "string" &&
		typeof window.period === "string" &&
		(window.scope === "account" ||
			window.scope === "model" ||
			window.scope === "meter") &&
		typeof window.usedPercent === "number" &&
		Number.isFinite(window.usedPercent)
	);
}

export function serializeAccountQuotaSnapshot(
	snapshot: StoredAccountQuotaSnapshot | null,
): AccountQuotaSnapshot | null {
	if (!snapshot) return null;

	return {
		windows: Array.isArray(snapshot.windows)
			? snapshot.windows.filter(isQuotaWindow)
			: [],
		collectedAt: snapshot.collectedAt,
		lastAttemptAt: snapshot.lastAttemptAt,
		state: snapshot.state,
		error: snapshot.error,
	};
}

/**
 * Best-effort check: does a successful quota report prove the account
 * currently has quota available? Unexpected or partial shapes fail closed.
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
			const allowed = d.allowed ?? rl?.allowed;
			const limitReached = d.limit_reached ?? rl?.limit_reached;
			return allowed === true && limitReached !== true;
		}

		if (provider === "claude-code") {
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
			return (
				windows.length > 0 &&
				windows.every((window) => (window.utilization as number) < 100)
			);
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
			for (const item of Array.isArray(d.limits) ? d.limits : []) {
				if (!item || typeof item !== "object") continue;
				const detail = (item as { detail?: unknown }).detail;
				if (!detail || typeof detail !== "object") continue;
				const detailRecord = detail as Record<string, unknown>;
				const detailLimit = Number(detailRecord.limit);
				const detailUsed = Number(detailRecord.used);
				if (
					Number.isFinite(detailLimit) &&
					detailLimit > 0 &&
					Number.isFinite(detailUsed) &&
					detailUsed >= detailLimit
				) {
					return false;
				}
			}
			return true;
		}
	} catch {
		return false;
	}

	return false;
}

export function createAccountQuotaService(
	dbOps: DatabaseOperations,
	getProvider: (provider: AccountProvider) => Provider | undefined,
	credentialManager: AccountCredentialManager,
): AccountQuotaRefresher {
	type InFlightRefresh = {
		promise: Promise<AccountQuotaResponse>;
		linkSignal(signal?: AbortSignal): void;
		abort(reason?: unknown): void;
	};
	const inFlight = new Map<string, InFlightRefresh>();

	const refreshOnce = async (
		accountId: string,
		signal?: AbortSignal,
	): Promise<AccountQuotaResponse> => {
		signal?.throwIfAborted();
		let account = dbOps.getAccount(accountId);
		if (!account) throw NotFound("Account not found");
		if (!QUOTA_PROVIDERS.has(account.provider)) {
			throw NotImplemented(
				`Quota checks are not implemented for provider '${account.provider}'`,
				{ provider: account.provider },
			);
		}

		const provider = getProvider(account.provider);
		if (!provider?.fetchQuota) {
			throw NotImplemented(
				`Quota checks are not implemented for provider '${account.provider}'`,
				{ provider: account.provider },
			);
		}

		try {
			let refreshed = false;
			const beforeValidation = account;
			account = await credentialManager.getValidAccount(account, signal);
			if (account.access_token !== beforeValidation.access_token) {
				refreshed = true;
			}

			let report = await provider.fetchQuota(
				account,
				quotaFetchWithSignal(signal),
			);
			signal?.throwIfAborted();
			if (
				!refreshed &&
				report.state === "failed" &&
				hasUnauthorizedSource(report)
			) {
				account = await credentialManager.refreshAfterUnauthorized(
					account,
					account.access_token ?? "",
					signal,
				);
				report = await provider.fetchQuota(
					account,
					quotaFetchWithSignal(signal),
				);
				signal?.throwIfAborted();
			}

			const response = toQuotaResponse(account, report);
			if (report.state === "failed") {
				dbOps.saveAccountQuotaFailure({
					accountId: account.id,
					error: "All provider quota sources failed",
					lastAttemptAt: report.collectedAt,
				});
				throw BadGateway("All provider quota sources failed", response);
			}
			if (response.windows.length === 0) {
				dbOps.saveAccountQuotaFailure({
					accountId: account.id,
					error: "No usable quota windows were returned",
					lastAttemptAt: report.collectedAt,
				});
				return response;
			}

			dbOps.saveAccountQuotaSuccess({
				accountId: account.id,
				windows: response.windows,
				collectedAt: report.collectedAt,
				lastAttemptAt: report.collectedAt,
			});

			try {
				if (
					account.rate_limited_until &&
					account.rate_limited_until > Date.now() &&
					quotaIndicatesAvailability(account.provider, report)
				) {
					dbOps.clearAccountRateLimit(account.id);
					log.info(
						`Cleared stale rate-limit state for account ${account.id} (${account.provider}): quota reports availability`,
					);
				}
			} catch (clearError) {
				log.warn(
					`Failed to clear stale rate-limit state for account ${account.id}`,
					failureMessage(clearError),
				);
			}

			return response;
		} catch (error) {
			if (signal?.aborted) throw error;
			if (error instanceof HttpError) throw error;
			const credentialError = credentialRefreshHttpError(error, account);
			if (credentialError) throw credentialError;
			dbOps.saveAccountQuotaFailure({
				accountId: account.id,
				error: failureMessage(error),
				lastAttemptAt: new Date().toISOString(),
			});
			log.error(
				`Quota check failed for account ${account.id} (${account.provider})`,
				failureMessage(error),
			);
			throw BadGateway("Failed to fetch account quota", {
				account: {
					id: account.id,
					name: account.name,
					provider: account.provider,
				},
			});
		}
	};

	return {
		isSupported(provider) {
			return QUOTA_PROVIDERS.has(provider);
		},
		refreshAccountQuota(accountId, signal) {
			const existing = inFlight.get(accountId);
			if (existing) {
				existing.linkSignal(signal);
				return existing.promise;
			}

			const controller = new AbortController();
			const removeAbortListeners = new Set<() => void>();
			const linkSignal = (callerSignal?: AbortSignal): void => {
				if (!callerSignal || controller.signal.aborted) return;
				if (callerSignal.aborted) {
					controller.abort(callerSignal.reason);
					return;
				}
				const forwardAbort = () => controller.abort(callerSignal.reason);
				callerSignal.addEventListener("abort", forwardAbort, { once: true });
				removeAbortListeners.add(() =>
					callerSignal.removeEventListener("abort", forwardAbort),
				);
			};
			linkSignal(signal);

			const refresh = refreshOnce(accountId, controller.signal).finally(() => {
				for (const removeListener of removeAbortListeners) removeListener();
				inFlight.delete(accountId);
			});
			inFlight.set(accountId, {
				promise: refresh,
				linkSignal,
				abort: (reason) => controller.abort(reason),
			});
			return refresh;
		},
		async shutdown(reason = new Error("Account quota service stopped")) {
			const activeRefreshes = [...inFlight.values()];
			for (const activeRefresh of activeRefreshes) {
				activeRefresh.abort(reason);
			}
			if (activeRefreshes.length === 0) return;

			let timeout: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.allSettled(
					activeRefreshes.map((activeRefresh) => activeRefresh.promise),
				),
				new Promise<void>((resolve) => {
					timeout = setTimeout(resolve, QUOTA_SHUTDOWN_GRACE_MS);
				}),
			]);
			if (timeout) clearTimeout(timeout);
		},
	};
}
