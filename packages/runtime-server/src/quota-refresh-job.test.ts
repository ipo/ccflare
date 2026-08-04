import { describe, expect, test } from "bun:test";
import type { AccountQuotaRefresher } from "@ccflare/api";
import type { DatabaseOperations } from "@ccflare/database";
import type { Logger } from "@ccflare/logger";
import { startQuotaRefreshJob } from "./quota-refresh-job";

type QuotaProvider = Parameters<AccountQuotaRefresher["isSupported"]>[0];
type TestAccount = { id: string; provider: QuotaProvider };

function account(id: string, provider: QuotaProvider): TestAccount {
	return { id, provider };
}

function harness(accounts: TestAccount[]) {
	let intervalCallback: (() => void) | undefined;
	let cancelled = false;
	const dbOps = {
		getAllAccounts: () => accounts,
	} as unknown as DatabaseOperations;
	const logger = { warn: () => undefined } as unknown as Logger;
	const options = {
		setIntervalFn: ((callback: () => void) => {
			intervalCallback = callback;
			return 1 as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval,
		clearIntervalFn: (() => {
			cancelled = true;
		}) as typeof clearInterval,
	};
	return {
		dbOps,
		logger,
		options,
		tick: () => intervalCallback?.(),
		wasCancelled: () => cancelled,
	};
}

describe("quota refresh job", () => {
	test("refreshes supported accounts immediately and on the interval", async () => {
		const testHarness = harness([
			account("claude", "claude-code"),
			account("codex", "codex"),
			account("kimi", "kimi"),
			account("openai", "openai"),
		]);
		const refreshed: string[] = [];
		const service: AccountQuotaRefresher = {
			isSupported: (provider) =>
				provider === "claude-code" ||
				provider === "codex" ||
				provider === "kimi",
			refreshAccountQuota: async (accountId) => {
				refreshed.push(accountId);
				return {} as Awaited<
					ReturnType<AccountQuotaRefresher["refreshAccountQuota"]>
				>;
			},
		};

		const job = startQuotaRefreshJob(
			testHarness.dbOps,
			service,
			testHarness.logger,
			testHarness.options,
		);
		await job.refreshNow();
		expect(refreshed).toEqual(["claude", "codex", "kimi"]);

		testHarness.tick();
		await job.refreshNow();
		expect(refreshed).toEqual([
			"claude",
			"codex",
			"kimi",
			"claude",
			"codex",
			"kimi",
		]);

		await job.stop();
		expect(testHarness.wasCancelled()).toBe(true);
	});

	test("coalesces an interval tick with an in-progress refresh", async () => {
		const testHarness = harness([account("codex", "codex")]);
		let release: (() => void) | undefined;
		let calls = 0;
		const service: AccountQuotaRefresher = {
			isSupported: () => true,
			refreshAccountQuota: async () => {
				calls++;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return {} as Awaited<
					ReturnType<AccountQuotaRefresher["refreshAccountQuota"]>
				>;
			},
		};

		const job = startQuotaRefreshJob(
			testHarness.dbOps,
			service,
			testHarness.logger,
			testHarness.options,
		);
		const firstRun = job.refreshNow();
		testHarness.tick();
		const overlappingRun = job.refreshNow();
		expect(calls).toBe(1);
		expect(overlappingRun).toBe(firstRun);

		release?.();
		await firstRun;
		await job.stop();
	});

	test("limits account refresh concurrency", async () => {
		const accounts = Array.from({ length: 8 }, (_, index) =>
			account(`account-${index}`, "codex"),
		);
		const testHarness = harness(accounts);
		let active = 0;
		let maxActive = 0;
		const service: AccountQuotaRefresher = {
			isSupported: () => true,
			refreshAccountQuota: async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await Promise.resolve();
				active--;
				return {} as Awaited<
					ReturnType<AccountQuotaRefresher["refreshAccountQuota"]>
				>;
			},
		};

		const job = startQuotaRefreshJob(
			testHarness.dbOps,
			service,
			testHarness.logger,
			testHarness.options,
		);
		await job.refreshNow();
		expect(maxActive).toBe(4);
		await job.stop();
	});

	test("aborts active refreshes without launching queued accounts", async () => {
		const accounts = Array.from({ length: 8 }, (_, index) =>
			account(`account-${index}`, "codex"),
		);
		const testHarness = harness(accounts);
		const started: string[] = [];
		const service: AccountQuotaRefresher = {
			isSupported: () => true,
			refreshAccountQuota: (accountId, signal) => {
				started.push(accountId);
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}) as ReturnType<AccountQuotaRefresher["refreshAccountQuota"]>;
			},
		};

		const job = startQuotaRefreshJob(
			testHarness.dbOps,
			service,
			testHarness.logger,
			testHarness.options,
		);
		await Promise.resolve();
		expect(started).toHaveLength(4);

		await job.stop();
		expect(started).toHaveLength(4);
	});
});
