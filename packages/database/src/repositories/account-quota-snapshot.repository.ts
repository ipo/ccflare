import { BaseRepository } from "./base.repository";

export type AccountQuotaSnapshotState = "fresh" | "stale" | "error";

export type AccountQuotaWindows = unknown[];

export interface AccountQuotaSnapshot {
	accountId: string;
	state: AccountQuotaSnapshotState;
	windows: AccountQuotaWindows | null;
	collectedAt: string | null;
	lastAttemptAt: string;
	error: string | null;
}

export interface SaveAccountQuotaSuccessInput {
	accountId: string;
	windows: readonly unknown[];
	collectedAt: string;
	lastAttemptAt: string;
}

export interface SaveAccountQuotaFailureInput {
	accountId: string;
	error: string;
	lastAttemptAt: string;
}

interface AccountQuotaSnapshotRow {
	account_id: string;
	state: AccountQuotaSnapshotState;
	windows_json: string | null;
	collected_at: string | null;
	last_attempt_at: string;
	error: string | null;
}

function toAccountQuotaSnapshot(
	row: AccountQuotaSnapshotRow,
): AccountQuotaSnapshot {
	let windows: AccountQuotaWindows | null = null;
	if (row.windows_json !== null) {
		try {
			const parsed: unknown = JSON.parse(row.windows_json);
			if (Array.isArray(parsed)) windows = parsed;
		} catch {
			// Treat malformed persisted JSON as an unusable snapshot below.
		}
	}

	if (row.windows_json !== null && windows === null) {
		return {
			accountId: row.account_id,
			state: "error",
			windows: null,
			collectedAt: null,
			lastAttemptAt: row.last_attempt_at,
			error: row.error ?? "Stored quota snapshot windows are invalid",
		};
	}

	return {
		accountId: row.account_id,
		state: row.state,
		windows,
		collectedAt: row.collected_at,
		lastAttemptAt: row.last_attempt_at,
		error: row.error,
	};
}

/**
 * Persists the latest successful quota windows and the outcome of the most
 * recent refresh attempt for each account.
 */
export class AccountQuotaSnapshotRepository extends BaseRepository<AccountQuotaSnapshot> {
	findAll(): AccountQuotaSnapshot[] {
		return this.query<AccountQuotaSnapshotRow>(
			`
				SELECT
					account_id,
					state,
					windows_json,
					collected_at,
					last_attempt_at,
					error
				FROM account_quota_snapshots
				ORDER BY account_id ASC
			`,
		).map(toAccountQuotaSnapshot);
	}

	findByAccountId(accountId: string): AccountQuotaSnapshot | null {
		const row = this.get<AccountQuotaSnapshotRow>(
			`
				SELECT
					account_id,
					state,
					windows_json,
					collected_at,
					last_attempt_at,
					error
				FROM account_quota_snapshots
				WHERE account_id = ?
			`,
			[accountId],
		);

		return row ? toAccountQuotaSnapshot(row) : null;
	}

	saveSuccess(input: SaveAccountQuotaSuccessInput): AccountQuotaSnapshot {
		this.run(
			`
				INSERT INTO account_quota_snapshots (
					account_id,
					state,
					windows_json,
					collected_at,
					last_attempt_at,
					error
				) VALUES (?, 'fresh', ?, ?, ?, NULL)
				ON CONFLICT(account_id) DO UPDATE SET
					state = 'fresh',
					windows_json = excluded.windows_json,
					collected_at = excluded.collected_at,
					last_attempt_at = excluded.last_attempt_at,
					error = NULL
			`,
			[
				input.accountId,
				JSON.stringify(input.windows),
				input.collectedAt,
				input.lastAttemptAt,
			],
		);

		return this.findByAccountId(input.accountId) as AccountQuotaSnapshot;
	}

	saveFailure(input: SaveAccountQuotaFailureInput): AccountQuotaSnapshot {
		this.run(
			`
				INSERT INTO account_quota_snapshots (
					account_id,
					state,
					windows_json,
					collected_at,
					last_attempt_at,
					error
				) VALUES (?, 'error', NULL, NULL, ?, ?)
				ON CONFLICT(account_id) DO UPDATE SET
					state = CASE
						WHEN account_quota_snapshots.windows_json IS NULL THEN 'error'
						ELSE 'stale'
					END,
					last_attempt_at = excluded.last_attempt_at,
					error = excluded.error
			`,
			[input.accountId, input.lastAttemptAt, input.error],
		);

		return this.findByAccountId(input.accountId) as AccountQuotaSnapshot;
	}
}
