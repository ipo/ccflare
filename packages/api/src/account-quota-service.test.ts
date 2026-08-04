import { afterEach, describe, expect, test } from "bun:test";
import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import type { Provider } from "@ccflare/providers";
import type { Account } from "@ccflare/types";
import { createAccountQuotaService } from "./account-quota-service";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("account quota service", () => {
	test("links a later scheduler abort to an API-first deduplicated refresh", async () => {
		const account = {
			id: "account-1",
			name: "quota owner",
			provider: "codex",
			access_token: "current-token",
			refresh_token: "refresh-token",
			expires_at: Date.now() + 60_000,
			rate_limited_until: null,
		} as Account;
		let snapshotWrites = 0;
		const dbOps = {
			getAccount: () => account,
			saveAccountQuotaSuccess: () => {
				snapshotWrites++;
			},
			saveAccountQuotaFailure: () => {
				snapshotWrites++;
			},
		} as unknown as DatabaseOperations;
		const provider = {
			fetchQuota: async (_account: Account, fetchFn = globalThis.fetch) => {
				await fetchFn("https://quota.example.test");
				throw new Error("unreachable");
			},
		} as unknown as Provider;
		globalThis.fetch = Object.assign(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal?.aborted) {
						reject(signal.reason);
						return;
					}
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const service = createAccountQuotaService(
			dbOps,
			{} as Config,
			() => provider,
		);
		const apiRefresh = service.refreshAccountQuota(account.id);
		await Promise.resolve();

		const schedulerAbort = new AbortController();
		const scheduledRefresh = service.refreshAccountQuota(
			account.id,
			schedulerAbort.signal,
		);
		expect(scheduledRefresh).toBe(apiRefresh);
		schedulerAbort.abort(new Error("scheduler stopped"));

		await expect(apiRefresh).rejects.toThrow("scheduler stopped");
		expect(snapshotWrites).toBe(0);
	});

	test("aborts and drains an API-only refresh during service shutdown", async () => {
		const account = {
			id: "account-2",
			name: "quota owner",
			provider: "codex",
			access_token: "current-token",
			refresh_token: "refresh-token",
			expires_at: Date.now() + 60_000,
			rate_limited_until: null,
		} as Account;
		let snapshotWrites = 0;
		const dbOps = {
			getAccount: () => account,
			saveAccountQuotaSuccess: () => snapshotWrites++,
			saveAccountQuotaFailure: () => snapshotWrites++,
		} as unknown as DatabaseOperations;
		const provider = {
			fetchQuota: async (_account: Account, fetchFn = globalThis.fetch) => {
				await fetchFn("https://quota.example.test");
				throw new Error("unreachable");
			},
		} as unknown as Provider;
		globalThis.fetch = Object.assign(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const service = createAccountQuotaService(
			dbOps,
			{} as Config,
			() => provider,
		);
		const refresh = service.refreshAccountQuota(account.id);
		await Promise.resolve();
		const shutdown = service.shutdown?.(new Error("server shutting down"));

		await expect(refresh).rejects.toThrow("server shutting down");
		await shutdown;
		expect(snapshotWrites).toBe(0);
	});
});
