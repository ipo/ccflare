declare var self: Worker;

import {
	DatabaseOperations,
	type RetentionCleanupStepResult,
} from "@ccflare/database";
import type {
	RetentionRunMessage,
	RetentionWorkerIncomingMessage,
	RetentionWorkerOutgoingMessage,
} from "./retention-worker-messages";

export const RETENTION_BATCH_PAUSE_MS = 25;
export const RETENTION_BUSY_BACKOFF_MS = 100;
export const RETENTION_BUSY_TIMEOUT_MS = 50;

let dbOps: DatabaseOperations | null = null;
let activeRun: Promise<void> | null = null;
let stopped = false;

function isEmptyStep(step: RetentionCleanupStepResult): boolean {
	return (
		step.removedRequests === 0 &&
		step.removedPayloads === 0 &&
		step.removedTranscriptChunks === 0 &&
		step.removedOrphanedPayloads === 0
	);
}

function isBusyError(error: unknown): boolean {
	const code =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: null;
	const message = error instanceof Error ? error.message : String(error);
	return (
		code === "SQLITE_BUSY" ||
		code === "SQLITE_LOCKED" ||
		/database is locked/i.test(message)
	);
}

function addStep(
	totals: RetentionCleanupStepResult,
	step: RetentionCleanupStepResult,
): void {
	totals.removedRequests += step.removedRequests;
	totals.removedPayloads += step.removedPayloads;
	totals.removedTranscriptChunks += step.removedTranscriptChunks;
	totals.removedOrphanedPayloads += step.removedOrphanedPayloads;
}

async function runCleanup(message: RetentionRunMessage): Promise<void> {
	dbOps ??= new DatabaseOperations(message.dbPath, {
		initializeSchema: false,
		busyTimeoutMs: RETENTION_BUSY_TIMEOUT_MS,
	});
	const totals: RetentionCleanupStepResult = {
		removedRequests: 0,
		removedPayloads: 0,
		removedTranscriptChunks: 0,
		removedOrphanedPayloads: 0,
	};

	try {
		while (!stopped) {
			let step: RetentionCleanupStepResult;
			try {
				step = dbOps.cleanupOldRequestsStep(
					message.payloadRetentionMs,
					message.requestRetentionMs,
					message.now,
				);
			} catch (error) {
				if (isBusyError(error)) {
					await Bun.sleep(RETENTION_BUSY_BACKOFF_MS);
					continue;
				}
				throw error;
			}

			if (isEmptyStep(step)) {
				if (isEmptyStep(totals)) {
					try {
						dbOps.optimize();
					} catch (error) {
						if (!isBusyError(error)) throw error;
					}
				}
				break;
			}
			addStep(totals, step);
			await Bun.sleep(RETENTION_BATCH_PAUSE_MS);
		}

		self.postMessage({
			type: "complete",
			runId: message.runId,
			totals,
		} satisfies RetentionWorkerOutgoingMessage);
	} catch (error) {
		self.postMessage({
			type: "error",
			runId: message.runId,
			message: error instanceof Error ? error.message : String(error),
		} satisfies RetentionWorkerOutgoingMessage);
	}
}

async function shutDown(): Promise<void> {
	stopped = true;
	try {
		await activeRun;
		dbOps?.close();
	} finally {
		dbOps = null;
		self.postMessage({
			type: "shutdown-complete",
		} satisfies RetentionWorkerOutgoingMessage);
	}
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
	self.onmessage = (event: MessageEvent<RetentionWorkerIncomingMessage>) => {
		if (event.data.type === "shutdown") {
			void shutDown();
			return;
		}

		if (activeRun || stopped) return;
		activeRun = runCleanup(event.data).finally(() => {
			activeRun = null;
		});
	};
	self.postMessage({ type: "ready" } satisfies RetentionWorkerOutgoingMessage);
}
