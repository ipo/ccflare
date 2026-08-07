import type { Config } from "@ccflare/config";
import type {
	DatabaseOperations,
	RetentionCleanupStepResult,
} from "@ccflare/database";
import type { Logger } from "@ccflare/logger";

export const RETENTION_FIRST_RUN_DELAY_MS = 10_000;
const HOUR_MS = 60 * 60 * 1_000;

export interface RetentionCleanupJob {
	runNow(): Promise<void>;
	stop(): Promise<void>;
}

export interface RetentionCleanupJobOptions {
	firstRunDelayMs?: number;
	intervalMs?: number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
	yieldToEventLoop?: () => Promise<void>;
}

function isEmptyStep(step: RetentionCleanupStepResult): boolean {
	return (
		step.removedRequests === 0 &&
		step.removedPayloads === 0 &&
		step.removedTranscriptChunks === 0 &&
		step.removedOrphanedPayloads === 0
	);
}

/** Runs bounded retention batches without overlapping whole cleanup passes. */
export function startRetentionCleanupJob(
	config: Config,
	dbOps: DatabaseOperations,
	log: Logger,
	options: RetentionCleanupJobOptions = {},
): RetentionCleanupJob {
	const firstRunDelayMs =
		options.firstRunDelayMs ?? RETENTION_FIRST_RUN_DELAY_MS;
	const intervalMs =
		options.intervalMs ?? config.getCleanupIntervalHours() * HOUR_MS;
	const scheduleTimeout = options.setTimeoutFn ?? setTimeout;
	const cancelTimeout = options.clearTimeoutFn ?? clearTimeout;
	const scheduleInterval = options.setIntervalFn ?? setInterval;
	const cancelInterval = options.clearIntervalFn ?? clearInterval;
	const yieldToEventLoop =
		options.yieldToEventLoop ??
		(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
	let stopped = false;
	let activeRun: Promise<void> | null = null;

	const run = async (): Promise<void> => {
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		const payloadRetentionMs = payloadDays * 24 * HOUR_MS;
		const requestRetentionMs = requestDays * 24 * HOUR_MS;
		const now = Date.now();
		const totals: RetentionCleanupStepResult = {
			removedRequests: 0,
			removedPayloads: 0,
			removedTranscriptChunks: 0,
			removedOrphanedPayloads: 0,
		};

		while (!stopped) {
			const step = dbOps.cleanupOldRequestsStep(
				payloadRetentionMs,
				requestRetentionMs,
				now,
			);
			if (isEmptyStep(step)) break;
			totals.removedRequests += step.removedRequests;
			totals.removedPayloads += step.removedPayloads;
			totals.removedTranscriptChunks += step.removedTranscriptChunks;
			totals.removedOrphanedPayloads += step.removedOrphanedPayloads;
			await yieldToEventLoop();
		}

		if (isEmptyStep(totals) && !stopped) dbOps.optimize();
		log.info(
			`Retention cleanup removed ${totals.removedRequests} requests, ${totals.removedPayloads} payloads, ${totals.removedTranscriptChunks} WebSocket transcript chunks, and ${totals.removedOrphanedPayloads} orphaned payloads (payload=${payloadDays}d, requests=${requestDays}d)`,
		);
	};

	const runNow = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (activeRun) return activeRun;
		activeRun = run()
			.catch((error) => {
				log.error(`Retention cleanup error: ${error}`);
			})
			.finally(() => {
				activeRun = null;
			});
		return activeRun;
	};

	const firstRunTimer = scheduleTimeout(() => void runNow(), firstRunDelayMs);
	const intervalTimer = scheduleInterval(() => void runNow(), intervalMs);

	return {
		runNow,
		async stop() {
			if (stopped) return;
			stopped = true;
			cancelTimeout(firstRunTimer);
			cancelInterval(intervalTimer);
			await activeRun;
		},
	};
}
