import type { Disposable } from "@ccflare/core";
import { Logger } from "@ccflare/logger";

const logger = new Logger("async-db-writer");

type DbJob = () => void | Promise<void>;
type Delay = (milliseconds: number) => Promise<void>;

interface AsyncDbWriterLogger {
	info(message: string, data?: unknown): void;
	error(message: string): void;
}

interface AsyncDbWriterOptions {
	delay?: Delay;
	logger?: AsyncDbWriterLogger;
}

export const ASYNC_DB_WRITER_RETRY_DELAYS_MS = [100, 500, 1_000] as const;

function delay(milliseconds: number): Promise<void> {
	return Bun.sleep(milliseconds);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRetryableSqliteError(error: unknown): boolean {
	const code =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: null;

	return (
		code === "SQLITE_BUSY" ||
		code === "SQLITE_LOCKED" ||
		/database is locked/i.test(getErrorMessage(error))
	);
}

export class AsyncDbWriter implements Disposable {
	private queue: DbJob[] = [];
	private running = false;
	private intervalId: Timer | null = null;
	private failureCount = 0;
	private disposePromise: Promise<void> | null = null;
	private currentRunPromise: Promise<void> | null = null;
	private readonly delay: Delay;
	private readonly logger: AsyncDbWriterLogger;

	constructor(options: AsyncDbWriterOptions = {}) {
		this.delay = options.delay ?? delay;
		this.logger = options.logger ?? logger;
		// Process queue every 100ms
		this.intervalId = setInterval(() => void this.processQueue(), 100);
	}

	enqueue(job: DbJob): void {
		this.queue.push(job);
		// Immediately try to process if not already running
		void this.processQueue();
	}

	private async processQueue(): Promise<void> {
		if (this.running) {
			return this.currentRunPromise ?? Promise.resolve();
		}

		if (this.queue.length === 0) {
			return;
		}

		this.running = true;
		this.currentRunPromise = (async () => {
			try {
				while (this.queue.length > 0) {
					const job = this.queue[0];
					if (!job) {
						this.queue.shift();
						continue;
					}
					await this.executeJob(job);
					this.queue.shift();
				}
			} finally {
				this.running = false;
				this.currentRunPromise = null;
			}
		})();

		return this.currentRunPromise;
	}

	private async executeJob(job: DbJob): Promise<void> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				await job();
				return;
			} catch (error) {
				const retryDelay = ASYNC_DB_WRITER_RETRY_DELAYS_MS[attempt];
				if (isRetryableSqliteError(error) && retryDelay !== undefined) {
					await this.delay(retryDelay);
					continue;
				}

				this.failureCount += 1;
				this.logger.error(
					`Failed to execute DB job: ${getErrorMessage(error)}`,
				);
				return;
			}
		}
	}

	isHealthy(): boolean {
		return this.failureCount === 0;
	}

	getFailureCount(): number {
		return this.failureCount;
	}

	getQueueSize(): number {
		return this.queue.length;
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}

		this.disposePromise = (async () => {
			this.logger.info("Flushing async DB writer queue...");

			// Stop the interval
			if (this.intervalId) {
				clearInterval(this.intervalId);
				this.intervalId = null;
			}

			// Process any remaining jobs
			await this.processQueue();

			this.logger.info("Async DB writer queue flushed", {
				remainingJobs: this.queue.length,
				failureCount: this.failureCount,
			});
		})();

		return this.disposePromise;
	}
}
