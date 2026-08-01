import type { Database } from "bun:sqlite";
import { Logger } from "@ccflare/logger";
import type { MigrationProgress } from "./migration-progress";

const log = new Logger("PerformanceIndexes");

const PERFORMANCE_INDEXES = [
	{
		name: "idx_requests_timestamp_account",
		operation:
			"create index idx_requests_timestamp_account on requests(timestamp DESC, account_used)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_timestamp_account
			ON requests(timestamp DESC, account_used)`,
	},
	{
		name: "idx_requests_model_timestamp",
		operation:
			"create partial index idx_requests_model_timestamp on requests(model, timestamp DESC)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_model_timestamp
			ON requests(model, timestamp DESC)
			WHERE model IS NOT NULL`,
	},
	{
		name: "idx_requests_success_timestamp",
		operation:
			"create index idx_requests_success_timestamp on requests(success, timestamp DESC)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_success_timestamp
			ON requests(success, timestamp DESC)`,
	},
	{
		name: "idx_accounts_paused",
		operation: "create partial index idx_accounts_paused on accounts(paused)",
		sql: `CREATE INDEX IF NOT EXISTS idx_accounts_paused
			ON accounts(paused)
			WHERE paused = 0`,
	},
	{
		name: "idx_requests_account_timestamp",
		operation:
			"create index idx_requests_account_timestamp on requests(account_used, timestamp DESC)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_account_timestamp
			ON requests(account_used, timestamp DESC)`,
	},
	{
		name: "idx_requests_cost_model",
		operation:
			"create partial index idx_requests_cost_model on requests(cost_usd, model, timestamp DESC)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_cost_model
			ON requests(cost_usd, model, timestamp DESC)
			WHERE cost_usd > 0 AND model IS NOT NULL`,
	},
	{
		name: "idx_requests_response_time",
		operation:
			"create partial index idx_requests_response_time on requests(model, response_time_ms)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_response_time
			ON requests(model, response_time_ms)
			WHERE response_time_ms IS NOT NULL AND model IS NOT NULL`,
	},
	{
		name: "idx_requests_tokens",
		operation:
			"create partial index idx_requests_tokens on requests(timestamp DESC, total_tokens)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_tokens
			ON requests(timestamp DESC, total_tokens)
			WHERE total_tokens > 0`,
	},
	{
		name: "idx_accounts_name",
		operation: "create index idx_accounts_name on accounts(name)",
		sql: `CREATE INDEX IF NOT EXISTS idx_accounts_name ON accounts(name)`,
	},
	{
		name: "idx_accounts_rate_limited",
		operation:
			"create partial index idx_accounts_rate_limited on accounts(rate_limited_until)",
		sql: `CREATE INDEX IF NOT EXISTS idx_accounts_rate_limited
			ON accounts(rate_limited_until)
			WHERE rate_limited_until IS NOT NULL`,
	},
	{
		name: "idx_accounts_session",
		operation:
			"create partial index idx_accounts_session on accounts(session_start, session_request_count)",
		sql: `CREATE INDEX IF NOT EXISTS idx_accounts_session
			ON accounts(session_start, session_request_count)
			WHERE session_start IS NOT NULL`,
	},
	{
		name: "idx_accounts_request_count",
		operation:
			"create index idx_accounts_request_count on accounts(request_count DESC, last_used)",
		sql: `CREATE INDEX IF NOT EXISTS idx_accounts_request_count
			ON accounts(request_count DESC, last_used)`,
	},
	{
		name: "idx_requests_response_id",
		operation:
			"create partial index idx_requests_response_id on requests(response_id)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_response_id
			ON requests(response_id)
			WHERE response_id IS NOT NULL`,
	},
	{
		name: "idx_requests_previous_response_id",
		operation:
			"create partial index idx_requests_previous_response_id on requests(previous_response_id)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_previous_response_id
			ON requests(previous_response_id)
			WHERE previous_response_id IS NOT NULL`,
	},
	{
		name: "idx_requests_response_chain_timestamp",
		operation:
			"create partial index idx_requests_response_chain_timestamp on requests(response_chain_id, timestamp ASC)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_response_chain_timestamp
			ON requests(response_chain_id, timestamp ASC)
			WHERE response_chain_id IS NOT NULL`,
	},
	{
		name: "idx_requests_client_session_timestamp",
		operation:
			"create partial index idx_requests_client_session_timestamp on requests(client_session_id, timestamp DESC)",
		sql: `CREATE INDEX IF NOT EXISTS idx_requests_client_session_timestamp
			ON requests(client_session_id, timestamp DESC)
			WHERE client_session_id IS NOT NULL`,
	},
] as const;

function indexExists(db: Database, indexName: string): boolean {
	return (
		db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
			)
			.get(indexName) !== null
	);
}

/**
 * Add performance indexes to improve query performance
 * This migration adds indexes based on common query patterns in the application
 */
export function addPerformanceIndexes(
	db: Database,
	progress: MigrationProgress,
): void {
	for (const index of PERFORMANCE_INDEXES) {
		const id = `index:${index.name}`;
		if (indexExists(db, index.name)) {
			progress.skip(id, index.operation, "already present");
			continue;
		}

		progress.apply(id, index.operation, () => db.run(index.sql));
	}
}

/**
 * Analyze current index usage and suggest optimizations
 */
export function analyzeIndexUsage(db: Database): void {
	log.info("\nAnalyzing index usage...");

	// Get all indexes
	const indexes = db
		.prepare(
			`SELECT name, tbl_name, sql 
			FROM sqlite_master 
			WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
			ORDER BY tbl_name, name`,
		)
		.all() as Array<{ name: string; tbl_name: string; sql: string }>;

	log.info(`\nTotal indexes: ${indexes.length}`);
	for (const index of indexes) {
		log.info(`- ${index.name} on ${index.tbl_name}`);
	}

	// Analyze table statistics
	const tables = ["accounts", "requests", "request_payloads"];
	for (const table of tables) {
		const count = db
			.prepare(`SELECT COUNT(*) as count FROM ${table}`)
			.get() as { count: number };
		log.info(`\n${table} table: ${count.count} rows`);
	}
}
