import { describe, expect, test } from "bun:test";
import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import type { Logger } from "@ccflare/logger";
import {
	createRetentionCleanupJob,
	RETENTION_FIRST_RUN_DELAY_MS,
	type RetentionCleanupJobOptions,
	resolveRetentionWorkerEntrypoint,
} from "./retention-cleanup-job";
import type {
	RetentionWorkerIncomingMessage,
	RetentionWorkerOutgoingMessage,
} from "./retention-worker-messages";

class FakeWorker {
	messages: RetentionWorkerIncomingMessage[] = [];
	onmessage:
		| ((event: MessageEvent<RetentionWorkerOutgoingMessage>) => void)
		| null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	terminated = false;

	postMessage(message: RetentionWorkerIncomingMessage): void {
		this.messages.push(message);
	}

	emit(message: RetentionWorkerOutgoingMessage): void {
		this.onmessage?.({
			data: message,
		} as MessageEvent<RetentionWorkerOutgoingMessage>);
	}

	terminate(): void {
		this.terminated = true;
	}
}

function fixtures(worker: FakeWorker) {
	const config = {
		getCleanupIntervalHours: () => 6,
		getDataRetentionDays: () => 7,
		getRequestRetentionDays: () => 365,
	} as Config;
	const dbOps = { getPath: () => "/tmp/ccflare-test.db" } as DatabaseOperations;
	const messages: string[] = [];
	const log = {
		info: (message: string) => messages.push(message),
		error: (message: string) => messages.push(message),
	} as unknown as Logger;
	const callbacks: Array<() => void> = [];
	let firstDelay: number | undefined;
	let intervalDelay: number | undefined;
	const options: RetentionCleanupJobOptions = {
		createWorker: () => worker,
		setTimeoutFn: ((callback: () => void, delay?: number) => {
			callbacks.push(callback);
			if (delay === RETENTION_FIRST_RUN_DELAY_MS) firstDelay = delay;
			return callbacks.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		clearTimeoutFn: (() => undefined) as typeof clearTimeout,
		setIntervalFn: ((callback: () => void, delay?: number) => {
			callbacks.push(callback);
			intervalDelay = Number(delay);
			return callbacks.length as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval,
		clearIntervalFn: (() => undefined) as typeof clearInterval,
	};
	return {
		config,
		dbOps,
		log,
		messages,
		callbacks,
		options,
		get firstDelay() {
			return firstDelay;
		},
		get intervalDelay() {
			return intervalDelay;
		},
	};
}

describe("retention cleanup job", () => {
	test("starts the worker and schedules the configured passes", () => {
		const worker = new FakeWorker();
		const context = fixtures(worker);
		const job = createRetentionCleanupJob(
			context.config,
			context.dbOps,
			context.log,
			context.options,
		);
		job.start();
		expect(context.firstDelay).toBe(RETENTION_FIRST_RUN_DELAY_MS);
		expect(context.intervalDelay).toBe(6 * 60 * 60 * 1_000);
	});

	test("rejects requests before readiness and coalesces active runs", async () => {
		const worker = new FakeWorker();
		const context = fixtures(worker);
		const job = createRetentionCleanupJob(
			context.config,
			context.dbOps,
			context.log,
			context.options,
		);
		job.start();
		expect(job.runNow()).toBe("unavailable");
		worker.emit({ type: "ready" });
		expect(job.runNow()).toBe("accepted");
		expect(job.runNow()).toBe("already_running");
		const run = worker.messages.find((message) => message.type === "run");
		expect(run).toMatchObject({
			dbPath: "/tmp/ccflare-test.db",
			payloadRetentionMs: 7 * 24 * 60 * 60 * 1_000,
			requestRetentionMs: 365 * 24 * 60 * 60 * 1_000,
		});
		if (!run || run.type !== "run") throw new Error("run not posted");
		worker.emit({
			type: "complete",
			runId: run.runId,
			totals: {
				removedRequests: 2,
				removedPayloads: 3,
				removedTranscriptChunks: 4,
				removedOrphanedPayloads: 1,
			},
		});
		expect(job.runNow()).toBe("accepted");
		const stop = job.stop();
		worker.emit({ type: "shutdown-complete" });
		await stop;
		expect(worker.terminated).toBeTrue();
	});

	test("runs a scheduled pass that fires before worker readiness", () => {
		const worker = new FakeWorker();
		const context = fixtures(worker);
		const job = createRetentionCleanupJob(
			context.config,
			context.dbOps,
			context.log,
			context.options,
		);
		job.start();
		const firstRunCallback = context.callbacks[1];
		expect(firstRunCallback).toBeDefined();
		firstRunCallback?.();
		expect(worker.messages).toHaveLength(0);
		worker.emit({ type: "ready" });
		expect(worker.messages).toHaveLength(1);
		expect(worker.messages[0]?.type).toBe("run");
	});

	test("resolves configured, bundled, and source worker entrypoints", () => {
		const previous = process.env.CF_RETENTION_WORKER_PATH;
		try {
			process.env.CF_RETENTION_WORKER_PATH = "/custom/retention.js";
			expect(resolveRetentionWorkerEntrypoint()).toBe(
				"file:///custom/retention.js",
			);
			delete process.env.CF_RETENTION_WORKER_PATH;
			expect(
				resolveRetentionWorkerEntrypoint("/opt/ccflare/ccflare", (path) =>
					path.endsWith("retention-cleanup.worker.js"),
				),
			).toBe("file:///opt/ccflare/retention-cleanup.worker.js");
			expect(
				resolveRetentionWorkerEntrypoint("/opt/ccflare/ccflare", () => false),
			).toEndWith("/retention-cleanup.worker.ts");
		} finally {
			if (previous === undefined) delete process.env.CF_RETENTION_WORKER_PATH;
			else process.env.CF_RETENTION_WORKER_PATH = previous;
		}
	});
});
