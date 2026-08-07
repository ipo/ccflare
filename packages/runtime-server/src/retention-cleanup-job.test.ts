import { describe, expect, test } from "bun:test";
import type { Config } from "@ccflare/config";
import type {
	DatabaseOperations,
	RetentionCleanupStepResult,
} from "@ccflare/database";
import type { Logger } from "@ccflare/logger";
import {
	RETENTION_FIRST_RUN_DELAY_MS,
	startRetentionCleanupJob,
} from "./retention-cleanup-job";

const emptyStep: RetentionCleanupStepResult = {
	removedRequests: 0,
	removedPayloads: 0,
	removedTranscriptChunks: 0,
	removedOrphanedPayloads: 0,
};

function inertTimers() {
	return {
		setTimeoutFn: (() => 1) as unknown as typeof setTimeout,
		clearTimeoutFn: (() => undefined) as typeof clearTimeout,
		setIntervalFn: (() => 2) as unknown as typeof setInterval,
		clearIntervalFn: (() => undefined) as typeof clearInterval,
	};
}

describe("retention cleanup job", () => {
	test("schedules the first pass after ten seconds and later passes at the configured interval", async () => {
		let firstDelay: number | undefined;
		let intervalDelay: number | undefined;
		const config = {
			getCleanupIntervalHours: () => 6,
			getDataRetentionDays: () => 7,
			getRequestRetentionDays: () => 365,
		} as Config;
		const dbOps = {
			cleanupOldRequestsStep: () => emptyStep,
			optimize: () => undefined,
		} as unknown as DatabaseOperations;
		const log = {
			info: () => undefined,
			error: () => undefined,
		} as unknown as Logger;
		const job = startRetentionCleanupJob(config, dbOps, log, {
			setTimeoutFn: ((
				_callback: Parameters<typeof setTimeout>[0],
				delay?: number,
			) => {
				firstDelay = Number(delay);
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout,
			clearTimeoutFn: (() => undefined) as typeof clearTimeout,
			setIntervalFn: ((
				_callback: Parameters<typeof setInterval>[0],
				delay?: number,
			) => {
				intervalDelay = Number(delay);
				return 2 as unknown as ReturnType<typeof setInterval>;
			}) as typeof setInterval,
			clearIntervalFn: (() => undefined) as typeof clearInterval,
		});

		expect(firstDelay).toBe(RETENTION_FIRST_RUN_DELAY_MS);
		expect(intervalDelay).toBe(6 * 60 * 60 * 1_000);
		await job.stop();
	});

	test("runs steps to completion, yields between nonempty batches, and summarizes once", async () => {
		const steps: RetentionCleanupStepResult[] = [
			{ ...emptyStep, removedRequests: 2 },
			{ ...emptyStep, removedPayloads: 1 },
			emptyStep,
		];
		let yields = 0;
		let optimizeCalls = 0;
		const messages: string[] = [];
		const config = {
			getCleanupIntervalHours: () => 6,
			getDataRetentionDays: () => 7,
			getRequestRetentionDays: () => 365,
		} as Config;
		const dbOps = {
			cleanupOldRequestsStep: () => steps.shift() ?? emptyStep,
			optimize: () => optimizeCalls++,
		} as unknown as DatabaseOperations;
		const log = {
			info: (message: string) => messages.push(message),
			error: () => undefined,
		} as unknown as Logger;
		const job = startRetentionCleanupJob(config, dbOps, log, {
			...inertTimers(),
			yieldToEventLoop: async () => {
				yields++;
			},
		});

		await job.runNow();
		expect(yields).toBe(2);
		expect(optimizeCalls).toBe(0);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("2 requests, 1 payloads");
		await job.stop();
	});

	test("optimizes only an empty full pass", async () => {
		let optimizeCalls = 0;
		const config = {
			getCleanupIntervalHours: () => 6,
			getDataRetentionDays: () => 7,
			getRequestRetentionDays: () => 365,
		} as Config;
		const dbOps = {
			cleanupOldRequestsStep: () => emptyStep,
			optimize: () => optimizeCalls++,
		} as unknown as DatabaseOperations;
		const log = {
			info: () => undefined,
			error: () => undefined,
		} as unknown as Logger;
		const job = startRetentionCleanupJob(config, dbOps, log, inertTimers());

		await job.runNow();
		expect(optimizeCalls).toBe(1);
		await job.stop();
	});
});
