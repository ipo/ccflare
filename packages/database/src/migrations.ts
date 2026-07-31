import type { Database } from "bun:sqlite";
import { Logger } from "@ccflare/logger";
import { extractRequestLinkageFromPayload } from "@ccflare/types";
import { addPerformanceIndexes } from "./performance-indexes";

const log = new Logger("DatabaseMigrations");
const REQUEST_LINKAGE_MIGRATION_ID = "request_linkage_backfill_v1";
const REQUEST_LINKAGE_BATCH_SIZE = 100;

interface TableInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

interface AccountNameRow {
	id: string;
	name: string;
	created_at: number | null;
}

function getTableInfo(db: Database, tableName: string): TableInfoRow[] {
	return db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
}

function hasColumn(columns: TableInfoRow[], columnName: string): boolean {
	return columns.some((column) => column.name === columnName);
}

function getColumn(
	columns: TableInfoRow[],
	columnName: string,
): TableInfoRow | null {
	return columns.find((column) => column.name === columnName) ?? null;
}

function columnOr(
	columns: TableInfoRow[],
	columnName: string,
	fallback: string,
): string {
	return hasColumn(columns, columnName) ? columnName : fallback;
}

function shouldMigrateAccountsTable(columns: TableInfoRow[]): boolean {
	const provider = getColumn(columns, "provider");
	const refreshToken = getColumn(columns, "refresh_token");
	const weight = getColumn(columns, "weight");
	const authMethod = getColumn(columns, "auth_method");
	const baseUrl = getColumn(columns, "base_url");

	return (
		!provider ||
		provider.notnull !== 1 ||
		provider.dflt_value !== null ||
		!refreshToken ||
		refreshToken.notnull !== 0 ||
		!weight ||
		weight.notnull !== 1 ||
		weight.dflt_value !== "1" ||
		!authMethod ||
		authMethod.notnull !== 1 ||
		!baseUrl ||
		hasColumn(columns, "account_tier")
	);
}

function shouldMigrateRequestsTable(columns: TableInfoRow[]): boolean {
	const provider = getColumn(columns, "provider");
	const upstreamPath = getColumn(columns, "upstream_path");
	const reasoningTokens = getColumn(columns, "reasoning_tokens");
	const responseChainId = getColumn(columns, "response_chain_id");
	const clientSessionId = getColumn(columns, "client_session_id");
	const ttftMs = getColumn(columns, "ttft_ms");
	const proxyOverheadMs = getColumn(columns, "proxy_overhead_ms");
	const upstreamTtfbMs = getColumn(columns, "upstream_ttfb_ms");
	const streamingDurationMs = getColumn(columns, "streaming_duration_ms");

	return (
		!provider ||
		provider.notnull !== 1 ||
		!upstreamPath ||
		upstreamPath.notnull !== 1 ||
		!reasoningTokens ||
		!responseChainId ||
		!clientSessionId ||
		!ttftMs ||
		!proxyOverheadMs ||
		!upstreamTtfbMs ||
		!streamingDurationMs ||
		hasColumn(columns, "conversation_id") ||
		hasColumn(columns, "agent_used")
	);
}

function ensureRequestLinkageColumns(db: Database): void {
	const columns = getTableInfo(db, "requests");
	const requestColumns = [
		["response_id", "TEXT"],
		["previous_response_id", "TEXT"],
		["response_chain_id", "TEXT"],
		["client_session_id", "TEXT"],
		["ttft_ms", "INTEGER"],
		["proxy_overhead_ms", "INTEGER"],
		["upstream_ttfb_ms", "INTEGER"],
		["streaming_duration_ms", "INTEGER"],
	] as const;

	for (const [columnName, columnType] of requestColumns) {
		if (!hasColumn(columns, columnName)) {
			db.run(`ALTER TABLE requests ADD COLUMN ${columnName} ${columnType}`);
		}
	}
}

function ensureSchemaMigrationsTable(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			id TEXT PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)
	`);
}

function isMigrationApplied(db: Database, id: string): boolean {
	return (
		db.query("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(id) !==
		null
	);
}

function markMigrationApplied(db: Database, id: string): void {
	db.run(
		"INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)",
		[id, Date.now()],
	);
}

function backfillRequestLinkageColumns(db: Database): void {
	if (isMigrationApplied(db, REQUEST_LINKAGE_MIGRATION_ID)) {
		return;
	}
	const hasMissingResponseChain =
		db
			.query("SELECT 1 FROM requests WHERE response_chain_id IS NULL LIMIT 1")
			.get() !== null;
	if (!hasMissingResponseChain) {
		markMigrationApplied(db, REQUEST_LINKAGE_MIGRATION_ID);
		return;
	}

	const selectRows = db.query<
		{
			id: string;
			timestamp: number;
			response_id: string | null;
			previous_response_id: string | null;
			client_session_id: string | null;
		},
		[number]
	>(`
		SELECT
			id,
			timestamp,
			response_id,
			previous_response_id,
			client_session_id
		FROM requests
		WHERE response_chain_id IS NULL
		ORDER BY timestamp ASC, id ASC
		LIMIT ?
	`);
	const selectPayload = db.query<{ json: string }, [string]>(
		"SELECT json FROM request_payloads WHERE id = ?",
	);
	const selectParentChain = db.query<{ response_chain_id: string }, [string]>(`
		SELECT response_chain_id
		FROM requests
		WHERE response_id = ? AND response_chain_id IS NOT NULL
		ORDER BY timestamp ASC, id ASC
		LIMIT 1
	`);

	const updateStmt = db.prepare(`
		UPDATE requests
		SET
			previous_response_id = ?,
			response_id = ?,
			response_chain_id = ?,
			client_session_id = ?
		WHERE id = ?
	`);

	let updatedRows = 0;
	while (true) {
		const rows = selectRows.all(REQUEST_LINKAGE_BATCH_SIZE);
		if (rows.length === 0) {
			break;
		}

		db.run("BEGIN");
		try {
			for (const row of rows) {
				let payload: unknown = null;
				const payloadRow = selectPayload.get(row.id);
				if (payloadRow) {
					try {
						payload = JSON.parse(payloadRow.json);
					} catch {
						payload = null;
					}
				}

				const extracted = extractRequestLinkageFromPayload(payload);
				const previousResponseId =
					extracted.previousResponseId ?? row.previous_response_id ?? null;
				const responseId = extracted.responseId ?? row.response_id ?? null;
				const clientSessionId =
					extracted.clientSessionId ?? row.client_session_id ?? null;
				const responseChainId = previousResponseId
					? (selectParentChain.get(previousResponseId)?.response_chain_id ??
						previousResponseId)
					: (responseId ?? row.id);

				updateStmt.run(
					previousResponseId,
					responseId,
					responseChainId,
					clientSessionId,
					row.id,
				);
				updatedRows++;
			}
			db.run("COMMIT");
		} catch (e) {
			db.run("ROLLBACK");
			throw e;
		}
	}

	markMigrationApplied(db, REQUEST_LINKAGE_MIGRATION_ID);

	if (updatedRows > 0) {
		log.info(`Backfilled request linkage for ${updatedRows} requests`);
	}
}

function migrateAccountsTable(db: Database, columns: TableInfoRow[]): void {
	const weightExpression = hasColumn(columns, "weight")
		? hasColumn(columns, "account_tier")
			? "COALESCE(weight, account_tier, 1)"
			: "COALESCE(weight, 1)"
		: hasColumn(columns, "account_tier")
			? "COALESCE(account_tier, 1)"
			: "1";

	db.run(`
		CREATE TABLE accounts_v2 (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT NOT NULL,
			auth_method TEXT NOT NULL,
			base_url TEXT,
			api_key TEXT,
			refresh_token TEXT,
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			weight INTEGER NOT NULL DEFAULT 1,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER
		)
	`);

	db.run(
		`
		INSERT INTO accounts_v2 (
			id, name, provider, auth_method, base_url, api_key, refresh_token,
			access_token, expires_at, created_at, last_used, request_count,
			total_requests, weight, rate_limited_until, session_start,
			session_request_count, paused, rate_limit_reset, rate_limit_status,
			rate_limit_remaining
		)
		SELECT
			id,
			name,
			${hasColumn(columns, "provider") ? "COALESCE(provider, 'anthropic')" : "'anthropic'"},
			${hasColumn(columns, "auth_method") ? "COALESCE(auth_method, 'oauth')" : "'oauth'"},
			${columnOr(columns, "base_url", "NULL")},
			${columnOr(columns, "api_key", "NULL")},
			${columnOr(columns, "refresh_token", "NULL")},
			${columnOr(columns, "access_token", "NULL")},
			${columnOr(columns, "expires_at", "NULL")},
			${columnOr(columns, "created_at", "CAST(unixepoch('subsec') * 1000 AS INTEGER)")},
			${columnOr(columns, "last_used", "NULL")},
			COALESCE(${columnOr(columns, "request_count", "NULL")}, 0),
			COALESCE(${columnOr(columns, "total_requests", "NULL")}, 0),
			${weightExpression},
			${columnOr(columns, "rate_limited_until", "NULL")},
			${columnOr(columns, "session_start", "NULL")},
			COALESCE(${columnOr(columns, "session_request_count", "NULL")}, 0),
			COALESCE(${columnOr(columns, "paused", "NULL")}, 0),
			${columnOr(columns, "rate_limit_reset", "NULL")},
			${columnOr(columns, "rate_limit_status", "NULL")},
			${columnOr(columns, "rate_limit_remaining", "NULL")}
		FROM accounts
	`,
	);

	db.run("DROP TABLE accounts");
	db.run("ALTER TABLE accounts_v2 RENAME TO accounts");
	log.info("Migrated accounts table to v2 schema");
}

function migrateRequestsTable(db: Database, columns: TableInfoRow[]): void {
	db.run(`
		CREATE TABLE requests_v2 (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			provider TEXT NOT NULL DEFAULT '',
			upstream_path TEXT NOT NULL DEFAULT '',
			account_used TEXT,
			status_code INTEGER,
			success BOOLEAN,
			error_message TEXT,
			response_time_ms INTEGER,
			failover_attempts INTEGER DEFAULT 0,
			model TEXT,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			cost_usd REAL DEFAULT 0,
			output_tokens_per_second REAL,
			input_tokens INTEGER DEFAULT 0,
			cache_read_input_tokens INTEGER DEFAULT 0,
			cache_creation_input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			reasoning_tokens INTEGER DEFAULT 0,
			response_id TEXT,
			previous_response_id TEXT,
			response_chain_id TEXT,
			client_session_id TEXT,
			ttft_ms INTEGER,
			proxy_overhead_ms INTEGER,
			upstream_ttfb_ms INTEGER,
			streaming_duration_ms INTEGER
		)
	`);

	db.run(
		`
		INSERT INTO requests_v2 (
			id, timestamp, method, path, provider, upstream_path, account_used,
			status_code, success, error_message, response_time_ms,
			failover_attempts, model, prompt_tokens, completion_tokens,
			total_tokens, cost_usd, output_tokens_per_second, input_tokens,
			cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
			reasoning_tokens, response_id, previous_response_id, response_chain_id,
			client_session_id, ttft_ms, proxy_overhead_ms, upstream_ttfb_ms,
			streaming_duration_ms
		)
		SELECT
			id,
			timestamp,
			method,
			path,
			${hasColumn(columns, "provider") ? "COALESCE(provider, '')" : "''"},
			${hasColumn(columns, "upstream_path") ? "COALESCE(upstream_path, '')" : "''"},
			${columnOr(columns, "account_used", "NULL")},
			${columnOr(columns, "status_code", "NULL")},
			${columnOr(columns, "success", "0")},
			${columnOr(columns, "error_message", "NULL")},
			${columnOr(columns, "response_time_ms", "NULL")},
			COALESCE(${columnOr(columns, "failover_attempts", "NULL")}, 0),
			${columnOr(columns, "model", "NULL")},
			COALESCE(${columnOr(columns, "prompt_tokens", "NULL")}, 0),
			COALESCE(${columnOr(columns, "completion_tokens", "NULL")}, 0),
			COALESCE(${columnOr(columns, "total_tokens", "NULL")}, 0),
			COALESCE(${columnOr(columns, "cost_usd", "NULL")}, 0),
			${columnOr(columns, "output_tokens_per_second", "NULL")},
			COALESCE(${columnOr(columns, "input_tokens", "NULL")}, 0),
			COALESCE(${columnOr(columns, "cache_read_input_tokens", "NULL")}, 0),
			COALESCE(${columnOr(columns, "cache_creation_input_tokens", "NULL")}, 0),
			COALESCE(${columnOr(columns, "output_tokens", "NULL")}, 0),
			COALESCE(${columnOr(columns, "reasoning_tokens", "NULL")}, 0),
			${columnOr(columns, "response_id", "NULL")},
			${columnOr(columns, "previous_response_id", "NULL")},
			${hasColumn(columns, "response_chain_id") ? "response_chain_id" : columnOr(columns, "conversation_id", "NULL")},
			${columnOr(columns, "client_session_id", "NULL")},
			${columnOr(columns, "ttft_ms", "NULL")},
			${columnOr(columns, "proxy_overhead_ms", "NULL")},
			${columnOr(columns, "upstream_ttfb_ms", "NULL")},
			${columnOr(columns, "streaming_duration_ms", "NULL")}
		FROM requests
	`,
	);

	db.run("DROP TABLE requests");
	db.run("ALTER TABLE requests_v2 RENAME TO requests");
	log.info("Migrated requests table to v2 schema");
}

function ensureAuthSessionsTable(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS auth_sessions (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			auth_method TEXT NOT NULL,
			account_name TEXT NOT NULL,
			state_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)
	`);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)`,
	);
}

function remediateDuplicateAccountNames(db: Database): void {
	const accounts = db
		.query<AccountNameRow, []>(
			`
				SELECT id, name, created_at
				FROM accounts
				ORDER BY name ASC, created_at ASC, id ASC
			`,
		)
		.all() as AccountNameRow[];

	if (accounts.length < 2) {
		return;
	}

	const duplicateGroups = new Map<string, AccountNameRow[]>();
	const usedNames = new Set(accounts.map((account) => account.name));

	for (const account of accounts) {
		const group = duplicateGroups.get(account.name);
		if (group) {
			group.push(account);
			continue;
		}

		duplicateGroups.set(account.name, [account]);
	}

	let renamedCount = 0;

	for (const [name, group] of duplicateGroups) {
		if (group.length < 2) {
			continue;
		}

		for (const account of group.slice(1)) {
			let suffix = 2;
			let candidate = `${name}-${suffix}`;

			while (usedNames.has(candidate)) {
				suffix += 1;
				candidate = `${name}-${suffix}`;
			}

			db.run(`UPDATE accounts SET name = ? WHERE id = ?`, [
				candidate,
				account.id,
			]);
			usedNames.add(candidate);
			renamedCount += 1;
		}
	}

	if (renamedCount > 0) {
		log.warn(
			`Renamed ${renamedCount} duplicate account name${renamedCount === 1 ? "" : "s"} before creating the accounts.name unique index`,
		);
	}
}

function ensureAccountsNameUniqueness(db: Database): void {
	remediateDuplicateAccountNames(db);
	db.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_name_unique ON accounts(name)`,
	);
}

export function ensureSchema(db: Database): void {
	// Create accounts table
	db.run(`
		CREATE TABLE IF NOT EXISTS accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT NOT NULL,
			auth_method TEXT NOT NULL,
			base_url TEXT,
			api_key TEXT,
			refresh_token TEXT,
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			weight INTEGER NOT NULL DEFAULT 1,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER
		)
	`);
	ensureAccountsNameUniqueness(db);

	// Create requests table
	db.run(`
		CREATE TABLE IF NOT EXISTS requests (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			provider TEXT NOT NULL DEFAULT '',
			upstream_path TEXT NOT NULL DEFAULT '',
			account_used TEXT,
			status_code INTEGER,
			success BOOLEAN,
			error_message TEXT,
			response_time_ms INTEGER,
			failover_attempts INTEGER DEFAULT 0,
			model TEXT,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			cost_usd REAL DEFAULT 0,
			output_tokens_per_second REAL,
			input_tokens INTEGER DEFAULT 0,
				cache_read_input_tokens INTEGER DEFAULT 0,
			cache_creation_input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			reasoning_tokens INTEGER DEFAULT 0,
			response_id TEXT,
			previous_response_id TEXT,
			response_chain_id TEXT,
			client_session_id TEXT,
			ttft_ms INTEGER,
			proxy_overhead_ms INTEGER,
			upstream_ttfb_ms INTEGER,
			streaming_duration_ms INTEGER
		)
	`);

	// Create index for faster queries
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC)`,
	);

	// Create request_payloads table for storing full request/response data
	db.run(`
		CREATE TABLE IF NOT EXISTS request_payloads (
			id TEXT PRIMARY KEY,
			json TEXT NOT NULL,
			FOREIGN KEY (id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);

	ensureAuthSessionsTable(db);
}

function ensureWebSocketTranscriptTable(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS websocket_transcript_chunks (
			request_id TEXT NOT NULL,
			chunk_sequence INTEGER NOT NULL,
			first_frame_sequence INTEGER NOT NULL,
			last_frame_sequence INTEGER NOT NULL,
			started_at INTEGER NOT NULL,
			ended_at INTEGER NOT NULL,
			format_version INTEGER NOT NULL,
			data BLOB NOT NULL,
			byte_length INTEGER NOT NULL,
			PRIMARY KEY (request_id, chunk_sequence),
			FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_websocket_chunks_request_last_frame
		ON websocket_transcript_chunks(request_id, last_frame_sequence)
	`);
}

function tableExists(db: Database, tableName: string): boolean {
	return (
		db
			.query(
				`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
			)
			.get(tableName) !== null
	);
}

function removeOrphanedRequestChildren(db: Database): void {
	for (const [table, column] of [
		["request_payloads", "id"],
		["websocket_transcript_chunks", "request_id"],
	] as const) {
		if (!tableExists(db, table)) continue;
		const result = db.run(
			`DELETE FROM ${table} WHERE ${column} NOT IN (SELECT id FROM requests)`,
		);
		if (result.changes > 0) {
			log.warn(
				`Removed ${result.changes} orphaned row(s) from ${table} before migration`,
			);
		}
	}
}

function rebuildLegacyTables(
	db: Database,
	options: {
		accounts: boolean;
		requests: boolean;
	},
): void {
	if (!options.accounts && !options.requests) return;

	const foreignKeys = db.query("PRAGMA foreign_keys").get() as {
		foreign_keys: 0 | 1;
	} | null;
	const restoreForeignKeys = foreignKeys?.foreign_keys === 1;
	if (options.requests) removeOrphanedRequestChildren(db);

	// SQLite ignores PRAGMA foreign_keys changes inside a transaction. Disable it
	// before rebuilding parent tables so DROP TABLE cannot cascade-delete child
	// payload/transcript rows.
	if (restoreForeignKeys) db.exec("PRAGMA foreign_keys = OFF");
	db.run("BEGIN");
	try {
		if (options.accounts) {
			migrateAccountsTable(db, getTableInfo(db, "accounts"));
		}
		if (options.requests) {
			migrateRequestsTable(db, getTableInfo(db, "requests"));
		}
		db.run("COMMIT");
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	} finally {
		if (restoreForeignKeys) db.exec("PRAGMA foreign_keys = ON");
	}

	const violations = db.query("PRAGMA foreign_key_check").all();
	if (violations.length > 0) {
		throw new Error(
			`Database migration left ${violations.length} foreign-key violation(s)`,
		);
	}
}

export function runMigrations(db: Database): void {
	// Ensure base schema exists first
	ensureSchema(db);
	ensureSchemaMigrationsTable(db);

	const accountsInfo = getTableInfo(db, "accounts");
	const requestsInfo = getTableInfo(db, "requests");
	rebuildLegacyTables(db, {
		accounts: shouldMigrateAccountsTable(accountsInfo),
		requests: shouldMigrateRequestsTable(requestsInfo),
	});

	ensureRequestLinkageColumns(db);
	backfillRequestLinkageColumns(db);

	db.run("DROP TABLE IF EXISTS agent_preferences");
	db.run("DROP TABLE IF EXISTS oauth_sessions");
	db.run("DROP INDEX IF EXISTS idx_oauth_sessions_expires");
	ensureAuthSessionsTable(db);
	ensureAccountsNameUniqueness(db);
	ensureWebSocketTranscriptTable(db);

	// Add performance indexes
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC)`,
	);
	addPerformanceIndexes(db);
}
