import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "@ccflare/config";
import type {
	DatabaseOperations,
	RetentionCleanupStepResult,
} from "@ccflare/database";
import type { Logger } from "@ccflare/logger";
import type {
	RetentionWorkerIncomingMessage,
	RetentionWorkerOutgoingMessage,
} from "./retention-worker-messages";

export const RETENTION_FIRST_RUN_DELAY_MS = 10_000;
export const RETENTION_WORKER_READY_TIMEOUT_MS = 15_000;
export const RETENTION_WORKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const HOUR_MS = 60 * 60 * 1_000;

export type RetentionCleanupRequestStatus =
	| "accepted"
	| "already_running"
	| "unavailable";

export interface RetentionCleanupJob {
	start(): void;
	runNow(): RetentionCleanupRequestStatus;
	stop(): Promise<void>;
}

interface RetentionWorkerLike {
	postMessage(message: RetentionWorkerIncomingMessage): void;
	terminate(): void;
	onmessage:
		| ((event: MessageEvent<RetentionWorkerOutgoingMessage>) => void)
		| null;
	onerror: ((event: ErrorEvent) => void) | null;
	unref?: () => void;
}

export interface RetentionCleanupJobOptions {
	firstRunDelayMs?: number;
	intervalMs?: number;
	readyTimeoutMs?: number;
	createWorker?: () => RetentionWorkerLike;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

export function resolveRetentionWorkerEntrypoint(
	executablePath = process.execPath,
	fileExists: (path: string) => boolean = existsSync,
): string {
	const configuredPath = process.env.CF_RETENTION_WORKER_PATH?.trim();
	if (configuredPath) {
		if (configuredPath.startsWith("file://")) return configuredPath;
		const absolutePath = isAbsolute(configuredPath)
			? configuredPath
			: resolve(process.cwd(), configuredPath);
		return pathToFileURL(absolutePath).href;
	}
	const bundledPath = join(
		dirname(executablePath),
		"retention-cleanup.worker.js",
	);
	if (fileExists(bundledPath)) return pathToFileURL(bundledPath).href;
	return new URL("./retention-cleanup.worker.ts", import.meta.url).href;
}

function createDefaultWorker(): RetentionWorkerLike {
	return new Worker(resolveRetentionWorkerEntrypoint(), {
		smol: true,
	}) as unknown as RetentionWorkerLike;
}

function formatTotals(totals: RetentionCleanupStepResult): string {
	return `${totals.removedRequests} requests, ${totals.removedPayloads} payloads, ${totals.removedTranscriptChunks} WebSocket transcript chunks, and ${totals.removedOrphanedPayloads} orphaned payloads`;
}

export function createRetentionCleanupJob(
	config: Config,
	dbOps: DatabaseOperations,
	log: Logger,
	options: RetentionCleanupJobOptions = {},
): RetentionCleanupJob {
	const scheduleTimeout = options.setTimeoutFn ?? setTimeout;
	const cancelTimeout = options.clearTimeoutFn ?? clearTimeout;
	const scheduleInterval = options.setIntervalFn ?? setInterval;
	const cancelInterval = options.clearIntervalFn ?? clearInterval;
	let worker: RetentionWorkerLike | null = null;
	let ready = false;
	let running = false;
	let started = false;
	let stopped = false;
	let firstRunTimer: ReturnType<typeof setTimeout> | null = null;
	let intervalTimer: ReturnType<typeof setInterval> | null = null;
	let readyTimer: ReturnType<typeof setTimeout> | null = null;
	let activeRunId: string | null = null;
	let pendingScheduledRun = false;
	let shutdownResolve: (() => void) | null = null;

	const markUnavailable = (message: string): void => {
		ready = false;
		log.error(message);
	};

	const postRun = (): RetentionCleanupRequestStatus => {
		if (!worker || !ready || stopped) return "unavailable";
		if (running) return "already_running";
		running = true;
		activeRunId = crypto.randomUUID();
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		try {
			worker.postMessage({
				type: "run",
				runId: activeRunId,
				dbPath: dbOps.getPath(),
				payloadRetentionMs: payloadDays * 24 * HOUR_MS,
				requestRetentionMs: requestDays * 24 * HOUR_MS,
				now: Date.now(),
			});
		} catch (error) {
			running = false;
			activeRunId = null;
			markUnavailable(`Failed to post retention cleanup work: ${error}`);
			return "unavailable";
		}
		return "accepted";
	};

	const onWorkerMessage = (message: RetentionWorkerOutgoingMessage): void => {
		switch (message.type) {
			case "ready":
				ready = true;
				if (readyTimer) cancelTimeout(readyTimer);
				readyTimer = null;
				if (pendingScheduledRun) {
					pendingScheduledRun = false;
					postRun();
				}
				break;
			case "complete":
				if (message.runId !== activeRunId) return;
				running = false;
				activeRunId = null;
				log.info(`Retention cleanup removed ${formatTotals(message.totals)}`);
				break;
			case "error":
				if (message.runId !== activeRunId) return;
				running = false;
				activeRunId = null;
				log.error(`Retention cleanup error: ${message.message}`);
				break;
			case "shutdown-complete":
				shutdownResolve?.();
				shutdownResolve = null;
				break;
		}
	};

	return {
		start() {
			if (started || stopped) return;
			started = true;
			try {
				worker = (options.createWorker ?? createDefaultWorker)();
				worker.onmessage = (event) => onWorkerMessage(event.data);
				worker.onerror = (event) => {
					running = false;
					markUnavailable(`Retention cleanup worker error: ${event.message}`);
					shutdownResolve?.();
					shutdownResolve = null;
				};
				worker.unref?.();
			} catch (error) {
				markUnavailable(`Failed to start retention cleanup worker: ${error}`);
				return;
			}
			readyTimer = scheduleTimeout(() => {
				if (!ready)
					markUnavailable("Retention cleanup worker readiness timed out");
			}, options.readyTimeoutMs ?? RETENTION_WORKER_READY_TIMEOUT_MS);
			firstRunTimer = scheduleTimeout(() => {
				if (postRun() === "unavailable" && worker && !stopped) {
					pendingScheduledRun = true;
				}
			}, options.firstRunDelayMs ?? RETENTION_FIRST_RUN_DELAY_MS);
			intervalTimer = scheduleInterval(
				() => {
					if (postRun() === "unavailable" && worker && !stopped) {
						pendingScheduledRun = true;
					}
				},
				options.intervalMs ?? config.getCleanupIntervalHours() * HOUR_MS,
			);
		},
		runNow: postRun,
		async stop() {
			if (stopped) return;
			stopped = true;
			ready = false;
			if (firstRunTimer) cancelTimeout(firstRunTimer);
			if (intervalTimer) cancelInterval(intervalTimer);
			if (readyTimer) cancelTimeout(readyTimer);
			if (!worker) return;
			const activeWorker = worker;
			await new Promise<void>((resolve) => {
				const timeout = scheduleTimeout(() => {
					shutdownResolve = null;
					resolve();
				}, RETENTION_WORKER_SHUTDOWN_TIMEOUT_MS);
				shutdownResolve = () => {
					cancelTimeout(timeout);
					resolve();
				};
				activeWorker.postMessage({ type: "shutdown" });
			});
			activeWorker.terminate();
			worker = null;
		},
	};
}
