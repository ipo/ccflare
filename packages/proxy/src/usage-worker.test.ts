import { afterEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_USAGE_WORKER_ACK_TIMEOUT_MS,
	DEFAULT_USAGE_WORKER_READY_TIMEOUT_MS,
	resolveUsageWorkerEntrypoint,
	UsageWorkerController,
	type WorkerLike,
} from "./usage-worker";
import type {
	AckMessage,
	ReadyMessage,
	ShutdownCompleteMessage,
	StartMessage,
	SummaryMessage,
} from "./worker-messages";

function createStartMessage(): StartMessage {
	return {
		type: "start",
		requestId: "req-1",
		accountId: "account-1",
		accountName: "Primary account",
		method: "POST",
		path: "/v1/openai/responses",
		upstreamPath: "/responses",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		responseStatus: 200,
		responseHeaders: {
			"content-type": "application/json",
		},
		isStream: false,
		providerName: "openai",
		retryAttempt: 0,
		failoverAttempts: 0,
	};
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 250,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (condition()) {
			return;
		}

		await Bun.sleep(5);
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

	postMessage(message: unknown): void {
		this.postedMessages.push(message);
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emitMessage(
		message:
			| ReadyMessage
			| AckMessage
			| ShutdownCompleteMessage
			| SummaryMessage,
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

const controllers: UsageWorkerController[] = [];
const originalUsageWorkerPath = process.env.CF_USAGE_WORKER_PATH;

afterEach(async () => {
	for (const controller of controllers) {
		await controller.terminateGracefully().catch(() => {});
	}
	controllers.length = 0;

	if (originalUsageWorkerPath === undefined) {
		delete process.env.CF_USAGE_WORKER_PATH;
	} else {
		process.env.CF_USAGE_WORKER_PATH = originalUsageWorkerPath;
	}
});

describe("UsageWorkerController", () => {
	it("allows 15 seconds for worker readiness and acknowledgements by default", () => {
		expect(DEFAULT_USAGE_WORKER_READY_TIMEOUT_MS).toBe(15_000);
		expect(DEFAULT_USAGE_WORKER_ACK_TIMEOUT_MS).toBe(15_000);
	});

	it("resolves an explicit usage worker path from the environment", () => {
		process.env.CF_USAGE_WORKER_PATH = "/tmp/post-processor.worker.js";

		expect(resolveUsageWorkerEntrypoint()).toBe(
			"file:///tmp/post-processor.worker.js",
		);
	});

	it("resolves a usage-worker sidecar beside a compiled executable", () => {
		const executablePath = "/opt/ccflare/ccflare-server";
		expect(
			resolveUsageWorkerEntrypoint(
				executablePath,
				(path) => path === "/opt/ccflare/post-processor.worker.js",
			),
		).toBe("file:///opt/ccflare/post-processor.worker.js");
	});

	it("queues outgoing messages until the worker sends ready", async () => {
		const workers: FakeWorker[] = [];
		const controller = new UsageWorkerController({
			createWorker() {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			readyTimeoutMs: 10_000,
			ackTimeoutMs: 10_000,
			shutdownDelayMs: 0,
			logger: new TestLogger(),
		});
		controllers.push(controller);

		controller.postMessage(createStartMessage());

		expect(workers).toHaveLength(1);
		expect(workers[0]?.postedMessages).toHaveLength(0);
		expect(typeof workers[0]?.onerror).toBe("function");
		expect(typeof workers[0]?.onmessageerror).toBe("function");

		workers[0]?.emitMessage({ type: "ready" });

		expect(workers[0]?.postedMessages).toHaveLength(1);
		expect(workers[0]?.postedMessages[0]).toMatchObject({
			type: "start",
			requestId: "req-1",
			messageId: expect.any(String),
		});
	});

	it("restarts the worker when the ready handshake never arrives", async () => {
		const workers: FakeWorker[] = [];
		const logger = new TestLogger();
		const controller = new UsageWorkerController({
			createWorker() {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			readyTimeoutMs: 15,
			ackTimeoutMs: 10_000,
			shutdownDelayMs: 0,
			logger,
		});
		controllers.push(controller);

		await waitFor(() => workers.length >= 2);
		workers[1]?.emitMessage({ type: "ready" });

		expect(workers[0]?.terminateCalls).toBe(1);
		expect(logger.warnings).toContain(
			"Usage worker did not become ready before the liveness timeout; restarting it",
		);
	});

	it("restarts the worker when an acknowledgement does not arrive", async () => {
		const workers: FakeWorker[] = [];
		const logger = new TestLogger();
		const controller = new UsageWorkerController({
			createWorker() {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			readyTimeoutMs: 10_000,
			ackTimeoutMs: 15,
			shutdownDelayMs: 0,
			logger,
		});
		controllers.push(controller);

		workers[0]?.emitMessage({ type: "ready" });
		controller.postMessage(createStartMessage());

		await waitFor(() => workers.length >= 2);
		workers[1]?.emitMessage({ type: "ready" });

		expect(workers[0]?.terminateCalls).toBe(1);
		expect(logger.warnings).toContain(
			"Usage worker became unresponsive while waiting for an acknowledgement; restarting it",
		);
	});

	it("restarts the worker after worker errors and message errors", async () => {
		const workers: FakeWorker[] = [];
		const logger = new TestLogger();
		const controller = new UsageWorkerController({
			createWorker() {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			readyTimeoutMs: 10_000,
			ackTimeoutMs: 10_000,
			shutdownDelayMs: 0,
			logger,
		});
		controllers.push(controller);

		workers[0]?.emitMessage({ type: "ready" });
		workers[0]?.emitError("worker crashed");

		await waitFor(() => workers.length >= 2);
		workers[1]?.emitMessage({ type: "ready" });
		workers[1]?.emitMessageError({ bad: true });

		await waitFor(() => workers.length >= 3);
		workers[2]?.emitMessage({ type: "ready" });

		expect(logger.errors).toEqual([
			"Usage worker crashed: worker crashed",
			"Usage worker emitted an invalid message payload",
		]);
	});

	it("awaits shutdown completion before terminating the worker", async () => {
		const workers: FakeWorker[] = [];
		const controller = new UsageWorkerController({
			createWorker() {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			readyTimeoutMs: 10_000,
			ackTimeoutMs: 10_000,
			shutdownDelayMs: 1_000,
			logger: new TestLogger(),
		});
		controllers.push(controller);

		workers[0]?.emitMessage({ type: "ready" });
		const shutdownPromise = controller.terminateGracefully();

		expect(workers[0]?.postedMessages.at(-1)).toMatchObject({
			type: "shutdown",
			messageId: expect.any(String),
		});
		expect(workers[0]?.terminateCalls).toBe(0);

		workers[0]?.emitMessage({
			type: "shutdown-complete",
			asyncWriter: {
				healthy: true,
				failureCount: 0,
				queuedJobs: 0,
			},
		});

		await shutdownPromise;
		expect(workers[0]?.terminateCalls).toBe(1);
		expect(controller.getHealthSnapshot().state).toBe("stopped");
	});

	it("rejects graceful shutdown when the worker never confirms completion", async () => {
		const workers: FakeWorker[] = [];
		const controller = new UsageWorkerController({
			createWorker() {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			readyTimeoutMs: 10_000,
			ackTimeoutMs: 10_000,
			shutdownDelayMs: 15,
			logger: new TestLogger(),
		});
		controllers.push(controller);

		workers[0]?.emitMessage({ type: "ready" });

		await expect(controller.terminateGracefully()).rejects.toThrow(
			"Usage worker did not confirm shutdown before the timeout elapsed",
		);
		expect(workers[0]?.terminateCalls).toBe(1);
		expect(controller.getHealthSnapshot().lastError).toBe(
			"Usage worker did not confirm shutdown before the timeout elapsed",
		);
	});
});
