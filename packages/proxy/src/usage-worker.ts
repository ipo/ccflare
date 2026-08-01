import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@ccflare/types";
import type {
	AckMessage,
	ControlMessage,
	IncomingWorkerMessage,
	OutgoingWorkerMessage,
	ReadyMessage,
	ShutdownCompleteMessage,
} from "./worker-messages";

export interface UsageWorkerTransport {
	postMessage(message: IncomingWorkerMessage): void;
}

export interface WorkerLike {
	postMessage(message: unknown): void;
	terminate(): void;
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
	unref?: () => void;
}

export interface UsageWorkerLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

export interface UsageWorkerHealthSnapshot {
	state: "starting" | "ready" | "shutting_down" | "stopped";
	queuedMessages: number;
	pendingAcks: number;
	lastError: string | null;
}

interface UsageWorkerControllerOptions {
	createWorker?: () => WorkerLike;
	onWorkerMessage?: (message: OutgoingWorkerMessage) => void;
	readyTimeoutMs?: number;
	ackTimeoutMs?: number;
	shutdownDelayMs?: number;
	logger?: UsageWorkerLogger;
}

type DecoratedIncomingWorkerMessage = IncomingWorkerMessage & {
	messageId: string;
};

interface PendingAck {
	message: DecoratedIncomingWorkerMessage;
	timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_USAGE_WORKER_READY_TIMEOUT_MS = 15_000;
export const DEFAULT_USAGE_WORKER_ACK_TIMEOUT_MS = 15_000;

const DEFAULT_READY_TIMEOUT_MS = Number(
	process.env.CF_USAGE_WORKER_READY_TIMEOUT_MS ||
		DEFAULT_USAGE_WORKER_READY_TIMEOUT_MS,
);
const DEFAULT_ACK_TIMEOUT_MS = Number(
	process.env.CF_USAGE_WORKER_ACK_TIMEOUT_MS ||
		DEFAULT_USAGE_WORKER_ACK_TIMEOUT_MS,
);
const DEFAULT_SHUTDOWN_DELAY_MS = 100;

function noop(): void {}

function createDefaultLogger(): UsageWorkerLogger {
	return {
		info: noop,
		warn: noop,
		error: noop,
		debug: noop,
	};
}

export function resolveUsageWorkerEntrypoint(
	executablePath = process.execPath,
	fileExists: (path: string) => boolean = existsSync,
): string {
	const configuredPath = process.env.CF_USAGE_WORKER_PATH?.trim();
	if (configuredPath) {
		if (configuredPath.startsWith("file://")) {
			return configuredPath;
		}

		const absolutePath = isAbsolute(configuredPath)
			? configuredPath
			: resolve(process.cwd(), configuredPath);
		return pathToFileURL(absolutePath).href;
	}

	const bundledPath = join(dirname(executablePath), "post-processor.worker.js");
	if (fileExists(bundledPath)) {
		return pathToFileURL(bundledPath).href;
	}

	return new URL("./post-processor.worker.ts", import.meta.url).href;
}

function createDefaultWorker(): WorkerLike {
	return new Worker(resolveUsageWorkerEntrypoint(), {
		smol: true,
	}) as unknown as WorkerLike;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	timer.unref?.();
}

function getEventMessage(event: ErrorEvent): string {
	if (typeof event.message === "string" && event.message.length > 0) {
		return event.message;
	}

	if (event.error instanceof Error && event.error.message.length > 0) {
		return event.error.message;
	}

	return "Unknown usage worker error";
}

function isReadyMessage(value: unknown): value is ReadyMessage {
	return isRecord(value) && value.type === "ready";
}

function isAckMessage(value: unknown): value is AckMessage {
	return (
		isRecord(value) &&
		value.type === "ack" &&
		typeof value.messageId === "string"
	);
}

function isShutdownCompleteMessage(
	value: unknown,
): value is ShutdownCompleteMessage {
	return (
		isRecord(value) &&
		value.type === "shutdown-complete" &&
		isRecord(value.asyncWriter) &&
		typeof value.asyncWriter.healthy === "boolean" &&
		typeof value.asyncWriter.failureCount === "number" &&
		typeof value.asyncWriter.queuedJobs === "number"
	);
}

export class UsageWorkerController implements UsageWorkerTransport {
	private readonly createWorkerImpl: () => WorkerLike;
	private readonly onWorkerMessage?: (message: OutgoingWorkerMessage) => void;
	private readonly readyTimeoutMs: number;
	private readonly ackTimeoutMs: number;
	private readonly shutdownDelayMs: number;
	private readonly logger: UsageWorkerLogger;
	private worker: WorkerLike | null = null;
	private ready = false;
	private shuttingDown = false;
	private generation = 0;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly queuedMessages: DecoratedIncomingWorkerMessage[] = [];
	private readonly pendingAcks = new Map<string, PendingAck>();
	private shutdownPromise: Promise<void> | null = null;
	private resolveShutdown: (() => void) | null = null;
	private rejectShutdown: ((error: Error) => void) | null = null;
	private lastError: string | null = null;

	constructor(options: UsageWorkerControllerOptions = {}) {
		this.createWorkerImpl = options.createWorker ?? createDefaultWorker;
		this.onWorkerMessage = options.onWorkerMessage;
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
		this.shutdownDelayMs = options.shutdownDelayMs ?? DEFAULT_SHUTDOWN_DELAY_MS;
		this.logger = options.logger ?? createDefaultLogger();
		this.startWorker();
	}

	postMessage(message: IncomingWorkerMessage): void {
		if (this.shuttingDown) {
			this.logger.warn(
				"Dropping usage worker message because the worker is shutting down",
			);
			return;
		}

		const decoratedMessage: DecoratedIncomingWorkerMessage = {
			...message,
			messageId: crypto.randomUUID(),
		};

		if (!this.ready || !this.worker) {
			this.queuedMessages.push(decoratedMessage);
			return;
		}

		this.sendMessage(decoratedMessage);
	}

	isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	getHealthSnapshot(): UsageWorkerHealthSnapshot {
		const state = !this.worker
			? "stopped"
			: this.shuttingDown
				? "shutting_down"
				: this.ready
					? "ready"
					: "starting";

		return {
			state,
			queuedMessages: this.queuedMessages.length,
			pendingAcks: this.pendingAcks.size,
			lastError: this.lastError,
		};
	}

	terminateGracefully(): Promise<void> {
		if (this.shutdownPromise) {
			return this.shutdownPromise;
		}

		this.shuttingDown = true;
		this.ready = false;
		this.clearReadyTimer();
		this.clearPendingAcks();
		this.queuedMessages.length = 0;

		const worker = this.worker;
		if (!worker) {
			this.shuttingDown = false;
			return Promise.resolve();
		}

		this.shutdownPromise = new Promise<void>((resolve, reject) => {
			this.resolveShutdown = resolve;
			this.rejectShutdown = reject;
		});
		const shutdownPromise = this.shutdownPromise;

		const shutdownMessage: ControlMessage = {
			type: "shutdown",
			messageId: crypto.randomUUID(),
		};

		try {
			worker.postMessage(shutdownMessage);
		} catch (error) {
			this.logger.debug(
				"Failed to post shutdown message to usage worker before termination",
				error,
			);
		}

		if (this.shutdownDelayMs <= 0) {
			this.finishShutdown(worker);
			return shutdownPromise;
		}

		this.shutdownTimer = setTimeout(() => {
			this.shutdownTimer = null;
			this.finishShutdown(
				worker,
				new Error(
					"Usage worker did not confirm shutdown before the timeout elapsed",
				),
			);
		}, this.shutdownDelayMs);
		unrefTimer(this.shutdownTimer);
		return shutdownPromise;
	}

	forceTerminate(): void {
		this.shuttingDown = true;
		this.ready = false;
		this.clearReadyTimer();
		this.clearPendingAcks();
		this.queuedMessages.length = 0;
		if (this.shutdownTimer) {
			clearTimeout(this.shutdownTimer);
			this.shutdownTimer = null;
		}

		const worker = this.worker;
		this.finishShutdown(worker, new Error("Usage worker was force terminated"));
	}

	private startWorker(): void {
		if (this.shuttingDown) {
			return;
		}

		const worker = this.createWorkerImpl();
		this.worker = worker;
		this.ready = false;
		this.generation += 1;
		const generation = this.generation;

		worker.onmessage = (event) => {
			if (this.worker !== worker || generation !== this.generation) {
				return;
			}

			this.handleWorkerMessage(event.data);
		};

		worker.onerror = (event) => {
			if (this.worker !== worker || generation !== this.generation) {
				return;
			}

			const message = getEventMessage(event);
			this.lastError = message;
			this.logger.error(`Usage worker crashed: ${message}`);
			if (this.shuttingDown) {
				this.finishShutdown(
					worker,
					new Error(`Usage worker crashed during shutdown: ${message}`),
				);
				return;
			}
			this.restartWorker();
		};

		worker.onmessageerror = () => {
			if (this.worker !== worker || generation !== this.generation) {
				return;
			}

			this.lastError = "Usage worker emitted an invalid message payload";
			this.logger.error("Usage worker emitted an invalid message payload");
			if (this.shuttingDown) {
				this.finishShutdown(
					worker,
					new Error("Usage worker emitted an invalid message during shutdown"),
				);
				return;
			}
			this.restartWorker();
		};

		worker.unref?.();
		this.armReadyTimeout(worker, generation);
	}

	private armReadyTimeout(worker: WorkerLike, generation: number): void {
		this.clearReadyTimer();
		const timer = setTimeout(() => {
			if (
				this.shuttingDown ||
				this.worker !== worker ||
				generation !== this.generation ||
				this.ready
			) {
				return;
			}

			this.logger.warn(
				"Usage worker did not become ready before the liveness timeout; restarting it",
			);
			this.restartWorker();
		}, this.readyTimeoutMs);
		unrefTimer(timer);
		this.readyTimer = timer;
	}

	private clearReadyTimer(): void {
		if (!this.readyTimer) {
			return;
		}

		clearTimeout(this.readyTimer);
		this.readyTimer = null;
	}

	private clearPendingAcks(): void {
		for (const pending of this.pendingAcks.values()) {
			clearTimeout(pending.timer);
		}
		this.pendingAcks.clear();
	}

	private handleWorkerMessage(message: unknown): void {
		if (isShutdownCompleteMessage(message)) {
			this.lastError = message.asyncWriter.healthy
				? this.lastError
				: `Usage worker async writer recorded ${message.asyncWriter.failureCount} failure(s)`;
			if (message.asyncWriter.healthy) {
				this.finishShutdown(this.worker);
			} else {
				this.finishShutdown(
					this.worker,
					new Error(
						`Usage worker async writer recorded ${message.asyncWriter.failureCount} failure(s) during shutdown`,
					),
				);
			}
			return;
		}

		if (this.shuttingDown) {
			return;
		}

		if (isReadyMessage(message)) {
			this.ready = true;
			this.lastError = null;
			this.clearReadyTimer();
			this.flushQueuedMessages();
			return;
		}

		if (isAckMessage(message)) {
			const pendingAck = this.pendingAcks.get(message.messageId);
			if (!pendingAck) {
				return;
			}

			clearTimeout(pendingAck.timer);
			this.pendingAcks.delete(message.messageId);
			return;
		}

		this.onWorkerMessage?.(message as OutgoingWorkerMessage);
	}

	private flushQueuedMessages(): void {
		if (!this.worker || !this.ready || this.queuedMessages.length === 0) {
			return;
		}

		const queuedMessages = this.queuedMessages.splice(
			0,
			this.queuedMessages.length,
		);
		for (const message of queuedMessages) {
			this.sendMessage(message);
		}
	}

	private sendMessage(message: DecoratedIncomingWorkerMessage): void {
		if (!this.worker) {
			this.queuedMessages.push(message);
			return;
		}

		try {
			this.worker.postMessage(message);
		} catch (error) {
			this.logger.error("Failed to post a message to the usage worker", error);
			this.restartWorker();
			return;
		}

		if (message.type === "shutdown") {
			return;
		}

		const timer = setTimeout(() => {
			const pendingAck = this.pendingAcks.get(message.messageId);
			if (!pendingAck) {
				return;
			}

			this.pendingAcks.delete(message.messageId);
			this.logger.warn(
				"Usage worker became unresponsive while waiting for an acknowledgement; restarting it",
			);
			this.restartWorker();
		}, this.ackTimeoutMs);
		unrefTimer(timer);

		this.pendingAcks.set(message.messageId, {
			message,
			timer,
		});
	}

	private restartWorker(): void {
		if (this.shuttingDown) {
			return;
		}

		this.clearReadyTimer();

		const pendingAckCount = this.pendingAcks.size;
		if (pendingAckCount > 0) {
			const requestIds = Array.from(
				new Set(
					Array.from(this.pendingAcks.values())
						.map((pending) =>
							"requestId" in pending.message
								? pending.message.requestId
								: undefined,
						)
						.filter(
							(requestId): requestId is string => typeof requestId === "string",
						),
				),
			);
			this.logger.warn(
				`Dropped ${pendingAckCount} in-flight usage worker messages during restart${
					requestIds.length > 0 ? ` (${requestIds.join(", ")})` : ""
				}`,
			);
		}

		this.clearPendingAcks();
		this.ready = false;

		const worker = this.worker;
		this.worker = null;

		try {
			worker?.terminate();
		} catch (error) {
			this.logger.debug("Failed to terminate the usage worker cleanly", error);
		}

		this.startWorker();
	}

	private finishShutdown(worker: WorkerLike | null, error?: Error): void {
		if (this.shutdownTimer) {
			clearTimeout(this.shutdownTimer);
			this.shutdownTimer = null;
		}

		if (this.worker === worker) {
			this.worker = null;
			this.generation += 1;
		}

		try {
			worker?.terminate();
		} catch (terminateError) {
			if (!error) {
				error =
					terminateError instanceof Error
						? terminateError
						: new Error(String(terminateError));
			}
		}

		this.ready = false;
		this.shuttingDown = false;

		const resolveShutdown = this.resolveShutdown;
		const rejectShutdown = this.rejectShutdown;
		this.resolveShutdown = null;
		this.rejectShutdown = null;
		this.shutdownPromise = null;

		if (error) {
			this.lastError = error.message;
			rejectShutdown?.(error);
			return;
		}

		resolveShutdown?.();
	}
}
