import type { RetentionCleanupStepResult } from "@ccflare/database";

export interface RetentionRunMessage {
	type: "run";
	runId: string;
	dbPath: string;
	payloadRetentionMs: number;
	requestRetentionMs: number;
	now: number;
}

export interface RetentionShutdownMessage {
	type: "shutdown";
}

export type RetentionWorkerIncomingMessage =
	| RetentionRunMessage
	| RetentionShutdownMessage;

export interface RetentionReadyMessage {
	type: "ready";
}

export interface RetentionCompleteMessage {
	type: "complete";
	runId: string;
	totals: RetentionCleanupStepResult;
}

export interface RetentionErrorMessage {
	type: "error";
	runId: string;
	message: string;
}

export interface RetentionShutdownCompleteMessage {
	type: "shutdown-complete";
}

export type RetentionWorkerOutgoingMessage =
	| RetentionReadyMessage
	| RetentionCompleteMessage
	| RetentionErrorMessage
	| RetentionShutdownCompleteMessage;
