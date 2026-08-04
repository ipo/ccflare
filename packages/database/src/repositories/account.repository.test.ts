import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { AccountRepository } from "./account.repository";

describe("AccountRepository", () => {
	let db: Database;
	let repository: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repository = new AccountRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates API key accounts and supports lookup/count queries", () => {
		const created = repository.create({
			name: "primary-anthropic",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
			base_url: "https://anthropic.internal",
		});

		expect(created).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				name: "primary-anthropic",
				provider: "anthropic",
				auth_method: "api_key",
				api_key: "sk-ant-test",
				base_url: "https://anthropic.internal",
				weight: 1,
				request_count: 0,
				total_requests: 0,
				paused: false,
			}),
		);
		expect(repository.count()).toBe(1);
		expect(repository.findById(created.id)).toEqual(created);
		expect(repository.findByName("primary-anthropic")).toEqual(created);
	});

	it("creates OAuth accounts and filters them by provider", () => {
		repository.create({
			name: "codex-main",
			provider: "codex",
			auth_method: "oauth",
			access_token: "codex-access-token",
			refresh_token: "codex-refresh-token",
			expires_at: 123_456,
		});
		repository.create({
			name: "openai-main",
			provider: "openai",
			auth_method: "api_key",
			api_key: "sk-openai-test",
		});

		const providerAccounts = repository.findByProvider("codex");

		expect(providerAccounts).toHaveLength(1);
		expect(providerAccounts[0]).toEqual(
			expect.objectContaining({
				name: "codex-main",
				provider: "codex",
				auth_method: "oauth",
				access_token: "codex-access-token",
				refresh_token: "codex-refresh-token",
				expires_at: 123_456,
			}),
		);
	});

	it("updates tokens only while both stored credentials match", () => {
		const account = repository.create({
			name: "guarded-refresh",
			provider: "kimi",
			auth_method: "oauth",
			access_token: "old-access",
			refresh_token: "old-refresh",
			expires_at: 1,
		});

		expect(
			repository.updateTokensIfCredentialsMatch(
				account.id,
				"wrong-access",
				"old-refresh",
				"stale-access",
				200,
				"stale-refresh",
			),
		).toBe(false);
		expect(repository.findById(account.id)?.access_token).toBe("old-access");

		expect(
			repository.updateTokensIfCredentialsMatch(
				account.id,
				"old-access",
				"old-refresh",
				"new-access",
				300,
				"new-refresh",
			),
		).toBe(true);
		expect(repository.findById(account.id)).toEqual(
			expect.objectContaining({
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_at: 300,
			}),
		);
	});

	it("filters rate-limited accounts unless explicitly included", () => {
		const usable = repository.create({
			name: "usable-codex",
			provider: "codex",
			auth_method: "oauth",
		});
		const limited = repository.create({
			name: "limited-codex",
			provider: "codex",
			auth_method: "oauth",
		});
		repository.setRateLimited(limited.id, Date.now() + 60_000);

		expect(
			repository.findAvailableForProvider("codex").map((a) => a.id),
		).toEqual([usable.id]);
		expect(
			repository
				.findAvailableForProvider("codex", true)
				.map((a) => a.id)
				.sort(),
		).toEqual([limited.id, usable.id].sort());
	});

	it("clears all persisted rate-limit state in one account update", () => {
		const account = repository.create({
			name: "clear-rate-limit",
			provider: "codex",
			auth_method: "oauth",
		});
		repository.setRateLimited(account.id, 10_000);
		repository.updateRateLimitMeta(account.id, "limited", 20_000, 0);

		expect(repository.findById(account.id)).toEqual(
			expect.objectContaining({
				rate_limited_until: 10_000,
				rate_limit_status: "limited",
				rate_limit_reset: 20_000,
				rate_limit_remaining: 0,
			}),
		);

		repository.clearRateLimited(account.id);

		expect(repository.findById(account.id)).toEqual(
			expect.objectContaining({
				rate_limited_until: null,
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limit_remaining: null,
			}),
		);
	});

	it("updates existing accounts and returns the updated row", () => {
		const created = repository.create({
			name: "rename-me",
			provider: "openai",
			auth_method: "api_key",
			api_key: "sk-openai-test",
		});

		const updated = repository.update(created.id, {
			name: "renamed-account",
			base_url: "https://custom.endpoint/v1",
		});

		expect(updated).toEqual(
			expect.objectContaining({
				id: created.id,
				name: "renamed-account",
				base_url: "https://custom.endpoint/v1",
				api_key: "sk-openai-test",
			}),
		);
		expect(repository.findByName("rename-me")).toBeNull();
		expect(repository.findByName("renamed-account")).toEqual(updated);
	});

	it("deletes accounts by id and reports whether anything changed", () => {
		const created = repository.create({
			name: "delete-me",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
		});

		expect(repository.delete(created.id)).toBe(true);
		expect(repository.findById(created.id)).toBeNull();
		expect(repository.count()).toBe(0);
		expect(repository.delete(created.id)).toBe(false);
	});

	it("rejects duplicate account names", () => {
		repository.create({
			name: "duplicate-name",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
		});

		expect(() =>
			repository.create({
				name: "duplicate-name",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-test",
			}),
		).toThrow(/accounts\.name|UNIQUE constraint failed/);
	});
});
