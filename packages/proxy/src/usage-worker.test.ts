import { afterEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_USAGE_WORKER_ACK_TIMEOUT_MS,
	DEFAULT_USAGE_WORKER_READY_TIMEOUT_MS,
	MAX_USAGE_WORKER_QUEUE_SIZE,
	resolveUsageWorkerEntrypoint,
	UsageWorkerController,
	type WorkerLike,
} from "./usage-worker";
import type {
	AckMessage,
	ReadyMessage,
	ShutdownCompleteMessage,
	StartMessage,
} from "./worker-messages";

function createStartMessage(requestId = "req-1"): StartMessage {
	return {
		type: "start",
		requestId,
		accountId: "account-1",
		accountName: "Primary account",
		method: "POST",
		path: "/v1/openai/responses",
		upstreamPath: "/responses",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		responseStatus: 200,
		responseHeaders: { "content-type": "application/json" },
		isStream: false,
		providerName: "openai",
		retryAttempt: 0,
		failoverAttempts: 0,
	};
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(2);
	}
	throw new Error("Timed out waiting for condition");
}

class TestLogger {
	readonly warnings: string[] = [];
	readonly errors: string[] = [];
	info(): void {}
	debug(): void {}
	warn(message: string): void {
		this.warnings.push(message);
	}
	error(message: string): void {
		this.errors.push(message);
	}
}

class FakeWorker implements WorkerLike {
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
	readonly postedMessages: unknown[] = [];
	terminateCalls = 0;
	unrefCalls = 0;
	throwOnPost: ((message: unknown) => boolean) | null = null;
	forbidTerminate = false;

	postMessage(message: unknown): void {
		if (this.throwOnPost?.(message)) throw new Error("post exploded");
		this.postedMessages.push(message);
	}
	terminate(): void {
		this.terminateCalls += 1;
		if (this.forbidTerminate) throw new Error("terminate forbidden");
	}
	unref(): void {
		this.unrefCalls += 1;
	}
	emitMessage(
		message: ReadyMessage | AckMessage | ShutdownCompleteMessage,
	): void {
		this.onmessage?.({ data: message } as MessageEvent<unknown>);
	}
	emitError(message: string): void {
		this.onerror?.({ message } as ErrorEvent);
	}
	emitMessageError(data: unknown): void {
		this.onmessageerror?.({ data } as MessageEvent<unknown>);
	}
}

interface TestController {
	controller: UsageWorkerController;
	workers: FakeWorker[];
}

const testControllers: TestController[] = [];
const originalUsageWorkerPath = process.env.CF_USAGE_WORKER_PATH;

function createController(
	options: Partial<ConstructorParameters<typeof UsageWorkerController>[0]> = {},
): TestController {
	const workers: FakeWorker[] = [];
	const controller = new UsageWorkerController({
		createWorker() {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
		readyTimeoutMs: 10_000,
		ackTimeoutMs: 10_000,
		shutdownDelayMs: 100,
		logger: new TestLogger(),
		...options,
	});
	const result = { controller, workers };
	testControllers.push(result);
	return result;
}

afterEach(async () => {
	for (const { controller, workers } of testControllers) {
		const shutdown = controller.terminateGracefully();
		workers.at(-1)?.emitMessage({
			type: "shutdown-complete",
			asyncWriter: { healthy: true, failureCount: 0, queuedJobs: 0 },
		});
		await shutdown.catch(() => {});
	}
	testControllers.length = 0;
	if (originalUsageWorkerPath === undefined) {
		delete process.env.CF_USAGE_WORKER_PATH;
	} else {
		process.env.CF_USAGE_WORKER_PATH = originalUsageWorkerPath;
	}
});

describe("UsageWorkerController", () => {
	it("keeps the documented readiness and acknowledgement defaults", () => {
		expect(DEFAULT_USAGE_WORKER_READY_TIMEOUT_MS).toBe(15_000);
		expect(DEFAULT_USAGE_WORKER_ACK_TIMEOUT_MS).toBe(15_000);
	});

	it("preserves explicit, compiled-sidecar, and TypeScript fallback precedence", () => {
		process.env.CF_USAGE_WORKER_PATH = "/tmp/explicit-worker.js";
		expect(resolveUsageWorkerEntrypoint()).toBe(
			"file:///tmp/explicit-worker.js",
		);

		delete process.env.CF_USAGE_WORKER_PATH;
		expect(
			resolveUsageWorkerEntrypoint(
				"/opt/ccflare/ccflare-server",
				(path) => path === "/opt/ccflare/post-processor.worker.js",
			),
		).toBe("file:///opt/ccflare/post-processor.worker.js");
		expect(resolveUsageWorkerEntrypoint("/tmp/bun", () => false)).toEndWith(
			"/post-processor.worker.ts",
		);
	});

	it("degrades on delayed readiness, caps the queue, and flushes it once on late ready", async () => {
		const logger = new TestLogger();
		const { controller, workers } = createController({
			readyTimeoutMs: 10,
			logger,
		});
		const worker = workers[0];
		if (!worker) throw new Error("Expected worker");
		worker.forbidTerminate = true;

		for (let index = 0; index < MAX_USAGE_WORKER_QUEUE_SIZE + 5; index += 1) {
			controller.postMessage(createStartMessage(`req-${index}`));
		}
		await waitFor(() => controller.getHealthSnapshot().state === "degraded");

		expect(workers).toHaveLength(1);
		expect(worker.terminateCalls).toBe(0);
		expect(controller.getHealthSnapshot().queuedMessages).toBe(1_000);
		expect(
			logger.warnings.filter((message) => message.includes("queue is full")),
		).toHaveLength(5);

		worker.emitMessage({ type: "ready" });
		expect(worker.postedMessages).toHaveLength(1_000);
		expect(controller.getHealthSnapshot()).toMatchObject({
			state: "ready",
			queuedMessages: 0,
			lastError: null,
		});
		worker.emitMessage({ type: "ready" });
		expect(worker.postedMessages).toHaveLength(1_000);

		worker.emitError("test cleanup");
		expect(worker.terminateCalls).toBe(0);
	});

	it("degrades one timed-out ACK without resend and a later valid pending ACK restores ready", async () => {
		const { controller, workers } = createController({ ackTimeoutMs: 40 });
		const worker = workers[0];
		if (!worker) throw new Error("Expected worker");
		worker.emitMessage({ type: "ready" });
		controller.postMessage(createStartMessage("first"));
		await Bun.sleep(25);
		controller.postMessage(createStartMessage("second"));
		await waitFor(() => controller.getHealthSnapshot().state === "degraded");

		expect(workers).toHaveLength(1);
		expect(worker.terminateCalls).toBe(0);
		expect(worker.postedMessages).toHaveLength(2);
		expect(controller.getHealthSnapshot().pendingAcks).toBe(1);

		const second = worker.postedMessages[1] as { messageId: string };
		worker.emitMessage({
			type: "ack",
			messageId: second.messageId,
			acknowledgedType: "start",
		});
		expect(controller.getHealthSnapshot()).toMatchObject({
			state: "ready",
			pendingAcks: 0,
			lastError: null,
		});
		expect(worker.postedMessages).toHaveLength(2);
	});

	it("stops on worker errors, clears pending ACKs, and drops later sends", () => {
		const { controller, workers } = createController();
		const worker = workers[0];
		if (!worker) throw new Error("Expected worker");
		worker.emitMessage({ type: "ready" });
		controller.postMessage(createStartMessage());
		expect(controller.getHealthSnapshot().pendingAcks).toBe(1);

		worker.emitError("worker crashed");
		expect(controller.getHealthSnapshot()).toMatchObject({
			state: "stopped",
			queuedMessages: 0,
			pendingAcks: 0,
		});
		controller.postMessage(createStartMessage("later"));
		expect(workers).toHaveLength(1);
		expect(worker.postedMessages).toHaveLength(1);
		expect(worker.terminateCalls).toBe(0);
	});

	it("stops on message errors and clears the readiness queue", () => {
		const { controller, workers } = createController();
		const worker = workers[0];
		if (!worker) throw new Error("Expected worker");
		controller.postMessage(createStartMessage());
		expect(controller.getHealthSnapshot().queuedMessages).toBe(1);

		worker.emitMessageError({ invalid: true });
		expect(controller.getHealthSnapshot()).toMatchObject({
			state: "stopped",
			queuedMessages: 0,
			pendingAcks: 0,
		});
		controller.postMessage(createStartMessage("later"));
		expect(workers).toHaveLength(1);
		expect(worker.postedMessages).toHaveLength(0);
		expect(worker.terminateCalls).toBe(0);
	});

	it("stops and clears the startup queue after a synchronous analytics post failure", () => {
		const { controller, workers } = createController();
		const worker = workers[0];
		if (!worker) throw new Error("Expected worker");
		worker.throwOnPost = (message) =>
			(message as { type?: string }).type !== "shutdown";

		controller.postMessage(createStartMessage());
		expect(controller.getHealthSnapshot().queuedMessages).toBe(1);
		worker.emitMessage({ type: "ready" });
		expect(controller.getHealthSnapshot()).toMatchObject({
			state: "stopped",
			queuedMessages: 0,
			pendingAcks: 0,
			lastError: "Failed to post a message to the usage worker: post exploded",
		});
		controller.postMessage(createStartMessage("later"));
		expect(workers).toHaveLength(1);
		expect(worker.terminateCalls).toBe(0);
	});

	it("terminates only after shutdown-complete", async () => {
		const { controller, workers } = createController({
			shutdownDelayMs: 1_000,
		});
		const worker = workers[0];
		if (!worker) throw new Error("Expected worker");
		worker.emitMessage({ type: "ready" });
		const shutdown = controller.terminateGracefully();
		expect(worker.terminateCalls).toBe(0);
		expect(worker.postedMessages.at(-1)).toMatchObject({ type: "shutdown" });

		worker.emitMessage({
			type: "shutdown-complete",
			asyncWriter: { healthy: true, failureCount: 0, queuedJobs: 0 },
		});
		await shutdown;
		expect(worker.terminateCalls).toBe(1);
		expect(controller.wasTerminatedSafely()).toBe(true);
	});

	it("rejects shutdown timeout without terminating", async () => {
		const { controller, workers } = createController({ shutdownDelayMs: 10 });
		const worker = workers[0];
		if (!worker) throw new Error("Expected worker");
		await expect(controller.terminateGracefully()).rejects.toThrow(
			"Usage worker did not confirm shutdown before the timeout elapsed",
		);
		expect(worker.terminateCalls).toBe(0);
		expect(controller.getHealthSnapshot().state).toBe("stopped");
	});

	it("rejects a failed shutdown post without terminating", async () => {
		const { controller, workers } = createController();
		const worker = workers[0];
		if (!worker) throw new Error("Expected worker");
		worker.throwOnPost = (message) =>
			(message as { type?: string }).type === "shutdown";

		await expect(controller.terminateGracefully()).rejects.toThrow(
			"Failed to post shutdown message to usage worker: post exploded",
		);
		expect(worker.terminateCalls).toBe(0);
	});
});
