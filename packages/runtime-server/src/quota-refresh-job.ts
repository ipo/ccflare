import type { AccountQuotaRefresher } from "@ccflare/api";
import type { DatabaseOperations } from "@ccflare/database";
import type { Logger } from "@ccflare/logger";

export const QUOTA_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const QUOTA_REFRESH_CONCURRENCY = 4;
export const QUOTA_REFRESH_STOP_GRACE_MS = 2_000;

export interface QuotaRefreshJob {
	refreshNow(): Promise<void>;
	stop(): Promise<void>;
}

export interface QuotaRefreshJobOptions {
	intervalMs?: number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

/** Refresh supported account quota without overlapping whole-job runs. */
export function startQuotaRefreshJob(
	dbOps: DatabaseOperations,
	quotaService: AccountQuotaRefresher,
	log: Logger,
	options: QuotaRefreshJobOptions = {},
): QuotaRefreshJob {
	const intervalMs = options.intervalMs ?? QUOTA_REFRESH_INTERVAL_MS;
	const schedule = options.setIntervalFn ?? setInterval;
	const cancel = options.clearIntervalFn ?? clearInterval;
	let activeRun: Promise<void> | null = null;
	let stopped = false;
	const abortController = new AbortController();

	const run = async (): Promise<void> => {
		const accounts = dbOps
			.getAllAccounts()
			.filter((account) => quotaService.isSupported(account.provider));
		let nextAccountIndex = 0;
		const refreshNext = async (): Promise<void> => {
			while (!stopped && nextAccountIndex < accounts.length) {
				const account = accounts[nextAccountIndex++];
				if (!account) continue;
				try {
					await quotaService.refreshAccountQuota(
						account.id,
						abortController.signal,
					);
				} catch (error) {
					if (stopped || abortController.signal.aborted) continue;
					log.warn(
						`Scheduled quota refresh failed for account ${account.id}`,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(QUOTA_REFRESH_CONCURRENCY, accounts.length) },
				() => refreshNext(),
			),
		);
	};

	const refreshNow = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (activeRun) return activeRun;

		activeRun = run().finally(() => {
			activeRun = null;
		});
		return activeRun;
	};

	void refreshNow();
	const timer = schedule(() => void refreshNow(), intervalMs);

	return {
		refreshNow,
		async stop() {
			if (stopped) return;
			stopped = true;
			cancel(timer);
			abortController.abort(new Error("Quota refresh job stopped"));
			const running = activeRun;
			if (!running) return;

			let timeout: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				running,
				new Promise<void>((resolve) => {
					timeout = setTimeout(resolve, QUOTA_REFRESH_STOP_GRACE_MS);
				}),
			]);
			if (timeout) clearTimeout(timeout);
		},
	};
}
