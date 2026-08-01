import { Logger, LogLevel } from "@ccflare/logger";

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Console-visible progress for synchronous SQLite migration work. Logging the
 * operation before invoking SQLite ensures a blocked statement is identifiable.
 */
export class MigrationProgress {
	private readonly startedAt = Date.now();
	private applied = 0;
	private skipped = 0;
	private failed = 0;

	constructor(
		private readonly log = new Logger("DatabaseMigrations", LogLevel.INFO, {
			silentConsole: process.env.NODE_ENV === "test",
		}),
	) {}

	apply<T>(id: string, operation: string, run: () => T): T {
		const startedAt = Date.now();
		this.log.info(`Applying migration ${id}: ${operation}`);

		try {
			const result = run();
			this.applied += 1;
			this.log.info(
				`Completed migration ${id}: ${operation} (${Date.now() - startedAt} ms)`,
			);
			return result;
		} catch (error) {
			this.failed += 1;
			this.log.error(
				`Failed migration ${id}: ${operation} after ${Date.now() - startedAt} ms: ${formatError(error)}`,
			);
			throw error;
		}
	}

	skip(id: string, operation: string, reason: string): void {
		this.skipped += 1;
		this.log.info(`Skipped migration ${id}: ${operation} (${reason})`);
	}

	summarize(): void {
		this.log.info(
			`Migration summary: ${this.applied} applied, ${this.skipped} skipped, ${this.failed} failed (${Date.now() - this.startedAt} ms total)`,
		);
	}
}
