import type { DatabaseOperations } from "@ccflare/database";
import { Logger } from "@ccflare/logger";
import type { Provider } from "@ccflare/providers";
import type {
	Account,
	AccountCredentialManager as AccountCredentialManagerContract,
	AccountProvider,
} from "@ccflare/types";

const TOKEN_SAFETY_WINDOW_MS = 30_000;
const REFRESH_FAILURE_BACKOFF_MS = 60_000;

type RefreshFailure = {
	accessToken: string | null;
	refreshToken: string | null;
	failedAt: number;
	error: unknown;
};

function needsRefresh(account: Account, now = Date.now()): boolean {
	return (
		!account.access_token ||
		account.expires_at === null ||
		account.expires_at - now <= TOKEN_SAFETY_WINDOW_MS
	);
}

function waitForCaller<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);

	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", aborted);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", aborted);
				reject(error);
			},
		);
	});
}

/** One runtime-wide, provider-neutral controller for OAuth credentials. */
export class AccountCredentialManager
	implements AccountCredentialManagerContract
{
	private readonly inFlight = new Map<string, Promise<Account>>();
	private readonly failures = new Map<string, RefreshFailure>();
	private readonly log = new Logger("AccountCredentialManager");

	constructor(
		private readonly dbOps: DatabaseOperations,
		private readonly clientId: string,
		private readonly getProvider: (
			provider: AccountProvider,
		) => Provider | undefined,
	) {}

	async getValidAccount(
		account: Account,
		signal?: AbortSignal,
	): Promise<Account> {
		signal?.throwIfAborted();
		const stored = this.loadAccount(account.id);
		if (!needsRefresh(stored)) return stored;
		return this.refresh(account.id, undefined, signal);
	}

	async refreshAfterUnauthorized(
		account: Account,
		rejectedAccessToken: string,
		signal?: AbortSignal,
	): Promise<Account> {
		signal?.throwIfAborted();
		const stored = this.loadAccount(account.id);
		if (stored.access_token && stored.access_token !== rejectedAccessToken) {
			return stored;
		}
		return this.refresh(account.id, rejectedAccessToken, signal);
	}

	private refresh(
		accountId: string,
		rejectedAccessToken: string | undefined,
		signal?: AbortSignal,
	): Promise<Account> {
		let refresh = this.inFlight.get(accountId);
		if (!refresh) {
			refresh = this.performRefresh(accountId, rejectedAccessToken).finally(
				() => {
					this.inFlight.delete(accountId);
				},
			);
			this.inFlight.set(accountId, refresh);
		}
		return waitForCaller(refresh, signal);
	}

	private async performRefresh(
		accountId: string,
		rejectedAccessToken: string | undefined,
	): Promise<Account> {
		// This read happens only after this caller owns the per-account slot.
		const account = this.loadAccount(accountId);
		if (rejectedAccessToken === undefined) {
			if (!needsRefresh(account)) return account;
		} else if (
			account.access_token &&
			account.access_token !== rejectedAccessToken
		) {
			return account;
		}

		const previousFailure = this.failures.get(account.id);
		if (
			previousFailure &&
			previousFailure.accessToken === account.access_token &&
			previousFailure.refreshToken === account.refresh_token &&
			Date.now() - previousFailure.failedAt < REFRESH_FAILURE_BACKOFF_MS
		) {
			throw previousFailure.error;
		}

		const provider = this.getProvider(account.provider);
		if (!provider?.refreshToken || !account.refresh_token) {
			throw new Error("No refresh token is available for this account");
		}

		try {
			// Caller cancellation is intentionally not forwarded. The provider's
			// existing request timeout still bounds this shared operation.
			const result = await provider.refreshToken(account, this.clientId);
			const accessToken = result.accessToken?.trim();
			const refreshToken = result.refreshToken?.trim();
			if (
				!accessToken ||
				!refreshToken ||
				!Number.isFinite(result.expiresAt) ||
				result.expiresAt <= Date.now()
			) {
				throw new Error(
					"Provider returned invalid refreshed OAuth credentials",
				);
			}

			const updated = this.dbOps.updateAccountTokensIfCredentialsMatch(
				account.id,
				account.access_token,
				account.refresh_token,
				accessToken,
				result.expiresAt,
				refreshToken,
			);
			const stored = this.loadAccount(account.id);
			this.failures.delete(account.id);
			if (updated) {
				this.log.info(
					`Successfully refreshed token for account: ${account.name}`,
				);
			}
			return stored;
		} catch (error) {
			this.failures.set(account.id, {
				accessToken: account.access_token,
				refreshToken: account.refresh_token,
				failedAt: Date.now(),
				error,
			});
			this.log.error(`Token refresh failed for account ${account.name}`);
			throw error;
		}
	}

	private loadAccount(accountId: string): Account {
		const account = this.dbOps.getAccount(accountId);
		if (!account)
			throw new Error("Account disappeared while refreshing credentials");
		return account;
	}
}
