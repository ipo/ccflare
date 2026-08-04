import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../migrations";
import { AccountRepository } from "./account.repository";
import { AccountQuotaSnapshotRepository } from "./account-quota-snapshot.repository";

describe("AccountQuotaSnapshotRepository", () => {
	let db: Database;
	let accounts: AccountRepository;
	let snapshots: AccountQuotaSnapshotRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		runMigrations(db);
		accounts = new AccountRepository(db);
		snapshots = new AccountQuotaSnapshotRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("stores and replaces the latest successful quota windows", () => {
		const account = accounts.create({
			name: "quota-success",
			provider: "codex",
			auth_method: "oauth",
		});

		expect(snapshots.findByAccountId(account.id)).toBeNull();

		const first = snapshots.saveSuccess({
			accountId: account.id,
			windows: [{ name: "primary", usedPercent: 25 }],
			collectedAt: "2026-08-04T10:00:00.000Z",
			lastAttemptAt: "2026-08-04T10:00:01.000Z",
		});
		expect(first).toEqual({
			accountId: account.id,
			state: "fresh",
			windows: [{ name: "primary", usedPercent: 25 }],
			collectedAt: "2026-08-04T10:00:00.000Z",
			lastAttemptAt: "2026-08-04T10:00:01.000Z",
			error: null,
		});

		expect(
			snapshots.saveSuccess({
				accountId: account.id,
				windows: [{ name: "primary", usedPercent: 40 }],
				collectedAt: "2026-08-04T10:05:00.000Z",
				lastAttemptAt: "2026-08-04T10:05:02.000Z",
			}),
		).toEqual({
			accountId: account.id,
			state: "fresh",
			windows: [{ name: "primary", usedPercent: 40 }],
			collectedAt: "2026-08-04T10:05:00.000Z",
			lastAttemptAt: "2026-08-04T10:05:02.000Z",
			error: null,
		});
	});

	it("preserves last-good windows when a later attempt fails", () => {
		const account = accounts.create({
			name: "quota-stale",
			provider: "claude-code",
			auth_method: "oauth",
		});
		const windows = [{ name: "seven_day", usedPercent: 70 }];

		snapshots.saveSuccess({
			accountId: account.id,
			windows,
			collectedAt: "2026-08-04T11:00:00.000Z",
			lastAttemptAt: "2026-08-04T11:00:01.000Z",
		});

		expect(
			snapshots.saveFailure({
				accountId: account.id,
				error: "quota endpoint timed out",
				lastAttemptAt: "2026-08-04T11:10:00.000Z",
			}),
		).toEqual({
			accountId: account.id,
			state: "stale",
			windows,
			collectedAt: "2026-08-04T11:00:00.000Z",
			lastAttemptAt: "2026-08-04T11:10:00.000Z",
			error: "quota endpoint timed out",
		});
	});

	it("records an error without inventing quota windows when no success exists", () => {
		const account = accounts.create({
			name: "quota-error",
			provider: "kimi",
			auth_method: "oauth",
		});

		expect(
			snapshots.saveFailure({
				accountId: account.id,
				error: "upstream unavailable",
				lastAttemptAt: "2026-08-04T12:00:00.000Z",
			}),
		).toEqual({
			accountId: account.id,
			state: "error",
			windows: null,
			collectedAt: null,
			lastAttemptAt: "2026-08-04T12:00:00.000Z",
			error: "upstream unavailable",
		});
	});

	it("lists snapshots and degrades invalid stored windows to an error", () => {
		const validAccount = accounts.create({
			name: "quota-valid",
			provider: "codex",
			auth_method: "oauth",
		});
		const invalidAccount = accounts.create({
			name: "quota-invalid",
			provider: "codex",
			auth_method: "oauth",
		});

		snapshots.saveSuccess({
			accountId: validAccount.id,
			windows: [],
			collectedAt: "2026-08-04T13:00:00.000Z",
			lastAttemptAt: "2026-08-04T13:00:00.000Z",
		});
		db.run(
			`
				INSERT INTO account_quota_snapshots (
					account_id, state, windows_json, collected_at, last_attempt_at, error
				) VALUES (?, 'fresh', ?, ?, ?, NULL)
			`,
			[
				invalidAccount.id,
				'{"not":"an array"}',
				"2026-08-04T13:01:00.000Z",
				"2026-08-04T13:01:00.000Z",
			],
		);

		const all = snapshots.findAll();
		expect(all).toHaveLength(2);
		expect(
			all.find((snapshot) => snapshot.accountId === validAccount.id),
		).toEqual(expect.objectContaining({ state: "fresh", windows: [] }));
		expect(
			all.find((snapshot) => snapshot.accountId === invalidAccount.id),
		).toEqual(
			expect.objectContaining({
				state: "error",
				windows: null,
				collectedAt: null,
				error: "Stored quota snapshot windows are invalid",
			}),
		);
	});

	it("does not throw when stored windows contain malformed JSON", () => {
		const account = accounts.create({
			name: "quota-malformed",
			provider: "codex",
			auth_method: "oauth",
		});
		db.run(
			`
				INSERT INTO account_quota_snapshots (
					account_id, state, windows_json, collected_at, last_attempt_at, error
				) VALUES (?, 'fresh', ?, ?, ?, NULL)
			`,
			[
				account.id,
				"not-json",
				"2026-08-04T13:02:00.000Z",
				"2026-08-04T13:02:00.000Z",
			],
		);

		expect(snapshots.findByAccountId(account.id)).toEqual(
			expect.objectContaining({
				state: "error",
				windows: null,
				collectedAt: null,
				error: "Stored quota snapshot windows are invalid",
			}),
		);
	});
});
