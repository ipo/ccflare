import type {
	AccountQuotaResponse,
	AccountQuotaSnapshot,
	AccountResponse,
} from "@ccflare/api";
import type { AccountProvider, TimeRange } from "@ccflare/types";
import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";
import { REFRESH_INTERVALS } from "../constants";
import { queryKeys } from "../lib/query-keys";

export const useAccounts = () => {
	return useQuery({
		queryKey: queryKeys.accounts(),
		queryFn: () => api.getAccounts(),
		refetchInterval: REFRESH_INTERVALS.fast, // Refresh every 10 seconds for rate limit updates
	});
};

const QUOTA_PROVIDERS = new Set<AccountProvider>([
	"claude-code",
	"codex",
	"kimi",
]);

function toQuotaSnapshot(response: AccountQuotaResponse): AccountQuotaSnapshot {
	const hasWindows = response.windows.length > 0;
	return {
		windows: response.windows,
		collectedAt: response.collectedAt,
		lastAttemptAt: response.collectedAt,
		state: hasWindows ? "fresh" : "error",
		error: hasWindows ? null : "No usable quota windows were returned.",
	};
}

/**
 * Fill missing account snapshots once per mounted query cache. The regular
 * accounts query remains the source of truth once the server exposes the
 * newly collected snapshot on its next refresh.
 */
export const useAccountQuotaSnapshots = (
	accounts: AccountResponse[] | undefined,
) => {
	const quotaQueries = useQueries({
		queries: (accounts ?? []).map((account) => ({
			queryKey: queryKeys.accountQuota(account.id),
			queryFn: () => api.getAccountQuota(account.id),
			enabled: account.quota === null && QUOTA_PROVIDERS.has(account.provider),
			staleTime: Number.POSITIVE_INFINITY,
			retry: false,
			refetchOnMount: false,
			refetchOnReconnect: false,
			refetchOnWindowFocus: false,
		})),
	});

	return accounts?.map((account, index) => {
		const liveQuota = quotaQueries[index]?.data;
		if (account.quota !== null || !liveQuota) return account;
		return { ...account, quota: toQuotaSnapshot(liveQuota) };
	});
};

export const useStats = (refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.stats(),
		queryFn: () => api.getStats(),
		refetchInterval: refetchInterval ?? REFRESH_INTERVALS.fast,
	});
};

export const useAnalytics = (
	timeRange: TimeRange,
	filters: {
		providers?: AccountProvider[];
		accounts?: string[];
		models?: string[];
		status?: "all" | "success" | "error";
	},
	viewMode: "normal" | "cumulative",
	modelBreakdown?: boolean,
) => {
	return useQuery({
		queryKey: queryKeys.analytics(timeRange, filters, viewMode, modelBreakdown),
		queryFn: () =>
			api.getAnalytics(timeRange, filters, viewMode, modelBreakdown),
	});
};

export const useLogHistory = () => {
	return useQuery({
		queryKey: queryKeys.logHistory(),
		queryFn: () => api.getLogHistory(),
	});
};

// Mutations
export const useRemoveAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ accountId }: { accountId: string }) =>
			api.removeAccount(accountId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useRenameAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			accountId,
			newName,
		}: {
			accountId: string;
			newName: string;
		}) => api.renameAccount(accountId, newName),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useResetAccountRateLimit = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (accountId: string) => api.resetAccountRateLimit(accountId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useResetStats = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.resetStats(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.stats() });
		},
	});
};

// Retention settings
export const useRetention = () => {
	return useQuery({
		queryKey: ["retention"],
		queryFn: () => api.getRetention(),
	});
};

export const useSetRetention = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (partial: { payloadDays?: number; requestDays?: number }) =>
			api.setRetention(partial),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["retention"] });
		},
	});
};

export const useCleanupNow = () => {
	return useMutation({
		mutationFn: () => api.cleanupNow(),
	});
};

export const useCompactDb = () => {
	return useMutation({
		mutationFn: () => api.compactDb(),
	});
};
