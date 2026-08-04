import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@ccflare/database";
import type { Provider, TokenRefreshResult } from "@ccflare/providers";
import type { Account } from "@ccflare/types";
import { AccountCredentialManager } from "./account-credential-manager";

const tempDirs: string[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createDb(): DatabaseOperations {
	const tempDir = mkdtempSync(join(tmpdir(), "ccflare-credentials-"));
	tempDirs.push(tempDir);
	return new DatabaseOperations(join(tempDir, "ccflare.db"));
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

describe("AccountCredentialManager", () => {
	it("deduplicates every consumer and persists rotated credentials before waiters resume", async () => {
		const dbOps = createDb();
		try {
			const account = dbOps.createOAuthAccount({
				name: "shared-kimi",
				provider: "kimi",
				accessToken: "old-access",
				refreshToken: "old-refresh",
				expiresAt: Date.now() - 1,
			});
			const providerResponse = deferred<TokenRefreshResult>();
			let providerCalls = 0;
			const provider = {
				async refreshToken() {
					providerCalls++;
					return providerResponse.promise;
				},
			} as unknown as Provider;
			let databaseUpdates = 0;
			const update = dbOps.updateAccountTokensIfCredentialsMatch.bind(dbOps);
			dbOps.updateAccountTokensIfCredentialsMatch = (...args) => {
				databaseUpdates++;
				return update(...args);
			};
			const manager = new AccountCredentialManager(
				dbOps,
				"client",
				() => provider,
			);

			// Proxy, manual quota, scheduled quota, and model callers all use this
			// exact operation on the same manager instance.
			const callers = ["proxy", "quota", "scheduled-quota", "models"].map(
				async () => {
					const result = await manager.getValidAccount(account);
					return { result, stored: dbOps.getAccount(account.id) };
				},
			);
			await Promise.resolve();
			expect(providerCalls).toBe(1);

			providerResponse.resolve({
				accessToken: "new-access",
				refreshToken: "rotated-refresh",
				expiresAt: Date.now() + 60_000,
			});
			const results = await Promise.all(callers);

			expect(databaseUpdates).toBe(1);
			expect(results).toHaveLength(4);
			for (const { result, stored } of results) {
				expect(result).toEqual(
					expect.objectContaining({
						access_token: "new-access",
						refresh_token: "rotated-refresh",
					}),
				);
				expect(stored).toEqual(
					expect.objectContaining({
						access_token: "new-access",
						refresh_token: "rotated-refresh",
					}),
				);
			}
		} finally {
			dbOps.close();
		}
	});

	it("reuses credentials already saved after an old token was rejected", async () => {
		const dbOps = createDb();
		try {
			const old = dbOps.createOAuthAccount({
				name: "codex-owner",
				provider: "codex",
				accessToken: "rejected-access",
				refreshToken: "old-refresh",
				expiresAt: Date.now() - 1,
			});
			let providerCalls = 0;
			const manager = new AccountCredentialManager(
				dbOps,
				"client",
				() =>
					({
						refreshToken: async () => {
							providerCalls++;
							return {
								accessToken: "already-refreshed",
								refreshToken: "rotated-refresh",
								expiresAt: Date.now() + 60_000,
							};
						},
					}) as unknown as Provider,
			);
			await manager.getValidAccount(old);

			const result = await manager.refreshAfterUnauthorized(
				old,
				"rejected-access",
			);
			expect(providerCalls).toBe(1);
			expect(result.access_token).toBe("already-refreshed");
		} finally {
			dbOps.close();
		}
	});

	it("allows refreshes for different accounts to proceed independently", async () => {
		const dbOps = createDb();
		try {
			const accounts = ["first", "second"].map((name) =>
				dbOps.createOAuthAccount({
					name,
					provider: "codex",
					accessToken: `${name}-access`,
					refreshToken: `${name}-refresh`,
					expiresAt: Date.now() - 1,
				}),
			);
			const responses = new Map(
				accounts.map((account) => [account.id, deferred<TokenRefreshResult>()]),
			);
			let providerCalls = 0;
			const manager = new AccountCredentialManager(
				dbOps,
				"client",
				() =>
					({
						refreshToken: async (account: Account) => {
							providerCalls++;
							return responses.get(account.id)
								?.promise as Promise<TokenRefreshResult>;
						},
					}) as unknown as Provider,
			);

			const refreshes = accounts.map((account) =>
				manager.getValidAccount(account),
			);
			await Promise.resolve();
			expect(providerCalls).toBe(2);
			for (const account of accounts) {
				responses.get(account.id)?.resolve({
					accessToken: `${account.name}-new-access`,
					refreshToken: `${account.name}-new-refresh`,
					expiresAt: Date.now() + 60_000,
				});
			}
			expect(
				(await Promise.all(refreshes)).map((account) => account.access_token),
			).toEqual(["first-new-access", "second-new-access"]);
		} finally {
			dbOps.close();
		}
	});

	it("does not overwrite credentials replaced while the provider refresh is in flight", async () => {
		const dbOps = createDb();
		try {
			const account = dbOps.createOAuthAccount({
				name: "login-race",
				provider: "kimi",
				accessToken: "old-access",
				refreshToken: "old-refresh",
				expiresAt: Date.now() - 1,
			});
			const providerResponse = deferred<TokenRefreshResult>();
			let guardResult: boolean | undefined;
			const guardedUpdate =
				dbOps.updateAccountTokensIfCredentialsMatch.bind(dbOps);
			dbOps.updateAccountTokensIfCredentialsMatch = (...args) => {
				guardResult = guardedUpdate(...args);
				return guardResult;
			};
			const manager = new AccountCredentialManager(
				dbOps,
				"client",
				() =>
					({
						refreshToken: async () => providerResponse.promise,
					}) as unknown as Provider,
			);
			const refresh = manager.getValidAccount(account);
			await Promise.resolve();

			dbOps.updateAccountTokens(
				account.id,
				"login-access",
				Date.now() + 120_000,
				"login-refresh",
			);
			providerResponse.resolve({
				accessToken: "provider-access",
				refreshToken: "provider-refresh",
				expiresAt: Date.now() + 60_000,
			});

			const result = await refresh;
			expect(guardResult).toBe(false);
			expect(result).toEqual(
				expect.objectContaining({
					access_token: "login-access",
					refresh_token: "login-refresh",
				}),
			);
			expect(dbOps.getAccount(account.id)?.access_token).toBe("login-access");
		} finally {
			dbOps.close();
		}
	});

	it("lets one caller abort waiting without cancelling the shared refresh", async () => {
		const dbOps = createDb();
		try {
			const account = dbOps.createOAuthAccount({
				name: "abort-waiter",
				provider: "claude-code",
				accessToken: "old-access",
				refreshToken: "old-refresh",
				expiresAt: Date.now() - 1,
			});
			const providerResponse = deferred<TokenRefreshResult>();
			let providerCalls = 0;
			const manager = new AccountCredentialManager(
				dbOps,
				"client",
				() =>
					({
						refreshToken: async () => {
							providerCalls++;
							return providerResponse.promise;
						},
					}) as unknown as Provider,
			);
			const abortController = new AbortController();
			const cancelled = manager.getValidAccount(
				account,
				abortController.signal,
			);
			const surviving = manager.getValidAccount(account);
			abortController.abort(new Error("caller stopped waiting"));

			await expect(cancelled).rejects.toThrow("caller stopped waiting");
			providerResponse.resolve({
				accessToken: "new-access",
				refreshToken: "new-refresh",
				expiresAt: Date.now() + 60_000,
			});
			expect((await surviving).access_token).toBe("new-access");
			expect(providerCalls).toBe(1);
			expect(dbOps.getAccount(account.id)?.refresh_token).toBe("new-refresh");
		} finally {
			dbOps.close();
		}
	});

	it("validates results and clears credential-scoped backoff after replacement", async () => {
		const dbOps = createDb();
		try {
			const account = dbOps.createOAuthAccount({
				name: "backoff-owner",
				provider: "kimi",
				accessToken: "failed-access",
				refreshToken: "failed-refresh",
				expiresAt: Date.now() - 1,
			});
			let calls = 0;
			const manager = new AccountCredentialManager(
				dbOps,
				"client",
				() =>
					({
						refreshToken: async () => {
							calls++;
							if (calls === 1) throw new Error("temporary failure");
							return {
								accessToken: "valid-access",
								refreshToken: "valid-refresh",
								expiresAt: Date.now() + 60_000,
							};
						},
					}) as unknown as Provider,
			);

			await expect(manager.getValidAccount(account)).rejects.toThrow(
				"temporary failure",
			);
			await expect(manager.getValidAccount(account)).rejects.toThrow(
				"temporary failure",
			);
			expect(calls).toBe(1);

			dbOps.updateAccountTokens(
				account.id,
				"replacement-access",
				Date.now() - 1,
				"replacement-refresh",
			);
			expect((await manager.getValidAccount(account)).access_token).toBe(
				"valid-access",
			);
			expect(calls).toBe(2);
		} finally {
			dbOps.close();
		}
	});

	it("rejects incomplete tokens, non-future expiry, and unusable refresh tokens", async () => {
		const invalidResults: TokenRefreshResult[] = [
			{
				accessToken: "",
				refreshToken: "new-refresh",
				expiresAt: Date.now() + 60_000,
			},
			{
				accessToken: "new-access",
				refreshToken: "new-refresh",
				expiresAt: Number.NaN,
			},
			{
				accessToken: "new-access",
				refreshToken: "   ",
				expiresAt: Date.now() + 60_000,
			},
		];

		for (const [index, result] of invalidResults.entries()) {
			const dbOps = createDb();
			try {
				const account = dbOps.createOAuthAccount({
					name: `invalid-result-${index}`,
					provider: "kimi",
					accessToken: "old-access",
					refreshToken: "old-refresh",
					expiresAt: Date.now() - 1,
				});
				const manager = new AccountCredentialManager(
					dbOps,
					"client",
					() =>
						({
							refreshToken: async () => result,
						}) as unknown as Provider,
				);

				await expect(manager.getValidAccount(account)).rejects.toThrow(
					"invalid refreshed OAuth credentials",
				);
				expect(dbOps.getAccount(account.id)).toEqual(
					expect.objectContaining({
						access_token: "old-access",
						refresh_token: "old-refresh",
					}),
				);
			} finally {
				dbOps.close();
			}
		}
	}, 15_000);
});
