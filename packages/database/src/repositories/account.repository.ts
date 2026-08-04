import type { Account } from "@ccflare/types";
import { type AccountRow, toAccount } from "../models/account-row";
import { BaseRepository } from "./base.repository";

export interface CreateAccountData {
	name: string;
	provider: Account["provider"];
	auth_method: Account["auth_method"];
	base_url?: string | null;
	api_key?: string | null;
	refresh_token?: string | null;
	access_token?: string | null;
	expires_at?: number | null;
	weight?: number;
}

export interface UpdateAccountData {
	name?: string;
	base_url?: string | null;
}

const accountSelectFields = `
	id, name, provider, auth_method, base_url, api_key, refresh_token, access_token,
	expires_at, created_at, last_used, request_count, total_requests,
	rate_limited_until, session_start, session_request_count,
	COALESCE(weight, 1) as weight,
	COALESCE(paused, 0) as paused,
	rate_limit_reset, rate_limit_status, rate_limit_remaining
`;

export class AccountRepository extends BaseRepository<Account> {
	findAll(): Account[] {
		const rows = this.query<AccountRow>(`
			SELECT ${accountSelectFields}
			FROM accounts
		`);
		return rows.map(toAccount);
	}

	create(data: CreateAccountData): Account {
		const id = crypto.randomUUID();
		const createdAt = Date.now();

		this.run(
			`
			INSERT INTO accounts (
				id, name, provider, auth_method, base_url, api_key, refresh_token,
				access_token, expires_at, created_at, request_count, total_requests, weight
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
		`,
			[
				id,
				data.name,
				data.provider,
				data.auth_method,
				data.base_url ?? null,
				data.api_key ?? null,
				data.refresh_token ?? null,
				data.access_token ?? null,
				data.expires_at ?? null,
				createdAt,
				data.weight ?? 1,
			],
		);

		return this.findById(id) as Account;
	}

	/**
	 * Create an API-key account with duplicate-name check.
	 * Throws if the name is already taken.
	 */
	createApiKeyAccount(opts: {
		name: string;
		provider: Account["provider"];
		apiKey: string;
		baseUrl?: string | null;
		weight?: number;
	}): Account {
		if (this.findByName(opts.name)) {
			throw new Error(`Account '${opts.name}' already exists`);
		}

		return this.create({
			name: opts.name,
			provider: opts.provider,
			auth_method: "api_key",
			api_key: opts.apiKey,
			base_url: opts.baseUrl,
			weight: opts.weight,
		});
	}

	/**
	 * Create an OAuth account with duplicate-name check.
	 * Throws if the name is already taken.
	 */
	createOAuthAccount(opts: {
		name: string;
		provider: Account["provider"];
		accessToken: string;
		refreshToken?: string | null;
		expiresAt?: number | null;
		baseUrl?: string | null;
		weight?: number;
	}): Account {
		if (this.findByName(opts.name)) {
			throw new Error(`Account '${opts.name}' already exists`);
		}

		return this.create({
			name: opts.name,
			provider: opts.provider,
			auth_method: "oauth",
			access_token: opts.accessToken,
			refresh_token: opts.refreshToken,
			expires_at: opts.expiresAt,
			base_url: opts.baseUrl,
			weight: opts.weight,
		});
	}

	findById(accountId: string): Account | null {
		const row = this.get<AccountRow>(
			`
			SELECT
				${accountSelectFields}
			FROM accounts
			WHERE id = ?
		`,
			[accountId],
		);

		return row ? toAccount(row) : null;
	}

	findByName(name: string): Account | null {
		const row = this.get<AccountRow>(
			`
			SELECT
				${accountSelectFields}
			FROM accounts
			WHERE name = ?
		`,
			[name],
		);

		return row ? toAccount(row) : null;
	}

	findByProvider(provider: Account["provider"]): Account[] {
		const rows = this.query<AccountRow>(
			`
			SELECT
				${accountSelectFields}
			FROM accounts
			WHERE provider = ?
		`,
			[provider],
		);

		return rows.map(toAccount);
	}

	/**
	 * Returns accounts available for routing: filters by provider and excludes
	 * paused accounts and those currently rate-limited, all pushed into SQL.
	 * `includeRateLimited` skips the rate-limit filter for models whose quota
	 * is metered separately from the account-level mark (see the proxy
	 * package's rate-limit exemptions).
	 */
	findAvailableForProvider(
		provider: Account["provider"],
		includeRateLimited = false,
	): Account[] {
		const now = Date.now();
		const rateLimitFilter = includeRateLimited
			? ""
			: "AND (rate_limited_until IS NULL OR rate_limited_until < ?)";
		const rows = this.query<AccountRow>(
			`
			SELECT
				${accountSelectFields}
			FROM accounts
			WHERE provider = ?
				AND COALESCE(paused, 0) = 0
				${rateLimitFilter}
		`,
			includeRateLimited ? [provider] : [provider, now],
		);

		return rows.map(toAccount);
	}

	update(accountId: string, data: UpdateAccountData): Account | null {
		const updates: string[] = [];
		const params: Array<string | null> = [];

		if (data.name !== undefined) {
			updates.push("name = ?");
			params.push(data.name);
		}

		if ("base_url" in data) {
			updates.push("base_url = ?");
			params.push(data.base_url ?? null);
		}

		if (updates.length === 0) {
			return this.findById(accountId);
		}

		params.push(accountId);
		const changes = this.runWithChanges(
			`UPDATE accounts SET ${updates.join(", ")} WHERE id = ?`,
			params,
		);

		return changes > 0 ? this.findById(accountId) : null;
	}

	delete(accountId: string): boolean {
		return (
			this.runWithChanges(`DELETE FROM accounts WHERE id = ?`, [accountId]) > 0
		);
	}

	count(): number {
		const result = this.get<{ count: number }>(
			"SELECT COUNT(*) as count FROM accounts",
		);
		return result?.count ?? 0;
	}

	updateTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number | null,
		refreshToken?: string,
	): void {
		if (refreshToken) {
			this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ? WHERE id = ?`,
				[accessToken, expiresAt, refreshToken, accountId],
			);
		} else {
			this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ? WHERE id = ?`,
				[accessToken, expiresAt, accountId],
			);
		}
	}

	incrementUsage(accountId: string, sessionDurationMs: number): void {
		const now = Date.now();
		this.run(
			`
			UPDATE accounts 
			SET 
				last_used = ?,
				request_count = request_count + 1,
				total_requests = total_requests + 1,
				session_start = CASE
					WHEN session_start IS NULL OR ? - session_start >= ? THEN ?
					ELSE session_start
				END,
				session_request_count = CASE
					WHEN session_start IS NULL OR ? - session_start >= ? THEN 1
					ELSE session_request_count + 1
				END
			WHERE id = ?
		`,
			[now, now, sessionDurationMs, now, now, sessionDurationMs, accountId],
		);
	}

	setRateLimited(accountId: string, until: number): void {
		this.run(`UPDATE accounts SET rate_limited_until = ? WHERE id = ?`, [
			until,
			accountId,
		]);
	}

	clearRateLimited(accountId: string): void {
		this.run(
			`
				UPDATE accounts
				SET
					rate_limited_until = NULL,
					rate_limit_status = NULL,
					rate_limit_reset = NULL,
					rate_limit_remaining = NULL
				WHERE id = ?
			`,
			[accountId],
		);
	}

	updateRateLimitMeta(
		accountId: string,
		status: string,
		reset: number | null,
		remaining?: number | null,
	): void {
		this.run(
			`UPDATE accounts SET rate_limit_status = ?, rate_limit_reset = ?, rate_limit_remaining = ? WHERE id = ?`,
			[status, reset, remaining ?? null, accountId],
		);
	}

	pause(accountId: string): void {
		this.run(`UPDATE accounts SET paused = 1 WHERE id = ?`, [accountId]);
	}

	resume(accountId: string): void {
		this.run(`UPDATE accounts SET paused = 0 WHERE id = ?`, [accountId]);
	}

	resetSession(accountId: string, timestamp: number): void {
		this.run(
			`UPDATE accounts SET session_start = ?, session_request_count = 0 WHERE id = ?`,
			[timestamp, accountId],
		);
	}

	updateRequestCount(accountId: string, count: number): void {
		this.run(`UPDATE accounts SET session_request_count = ? WHERE id = ?`, [
			count,
			accountId,
		]);
	}

	resetStatistics(resetSessionStart = false): void {
		if (resetSessionStart) {
			this.run(
				`UPDATE accounts SET request_count = 0, session_start = NULL, session_request_count = 0`,
			);
			return;
		}

		this.run(
			`UPDATE accounts SET request_count = 0, session_request_count = 0`,
		);
	}
}
