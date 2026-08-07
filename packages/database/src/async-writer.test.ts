import { describe, expect, it } from "bun:test";
import { ASYNC_DB_WRITER_RETRY_DELAYS_MS, AsyncDbWriter } from "./async-writer";

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
	readonly errors: string[] = [];
	info(): void {}
	error(message: string): void {
		this.errors.push(message);
	}
}

function sqliteError(message: string, code?: string): Error {
	return Object.assign(new Error(message), code ? { code } : {});
}

describe("AsyncDbWriter", () => {
	it("retries a transient SQLite lock and uses the configured yielding delay", async () => {
		const delays: number[] = [];
		let attempts = 0;
		const writer = new AsyncDbWriter({
			delay: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		writer.enqueue(() => {
			attempts += 1;
			if (attempts === 1) throw sqliteError("busy", "SQLITE_BUSY");
		});

		await writer.dispose();
		expect(attempts).toBe(2);
		expect(delays).toEqual([100]);
		expect(writer.getFailureCount()).toBe(0);
	});

	it("records one persistent-lock failure after three retries with the SQLite message", async () => {
		const logger = new TestLogger();
		const delays: number[] = [];
		let attempts = 0;
		const writer = new AsyncDbWriter({
			logger,
			delay: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		writer.enqueue(() => {
			attempts += 1;
			throw sqliteError("DATABASE IS LOCKED while writing");
		});

		await writer.dispose();
		expect(attempts).toBe(4);
		expect(delays).toEqual([...ASYNC_DB_WRITER_RETRY_DELAYS_MS]);
		expect(writer.getFailureCount()).toBe(1);
		expect(logger.errors).toEqual([
			"Failed to execute DB job: DATABASE IS LOCKED while writing",
		]);
	});

	it("does not retry unrelated failures", async () => {
		const logger = new TestLogger();
		const delays: number[] = [];
		let attempts = 0;
		const writer = new AsyncDbWriter({
			logger,
			delay: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		writer.enqueue(() => {
			attempts += 1;
			throw new Error("constraint failed");
		});

		await writer.dispose();
		expect(attempts).toBe(1);
		expect(delays).toEqual([]);
		expect(writer.getFailureCount()).toBe(1);
		expect(logger.errors[0]).toContain("constraint failed");
	});

	it("keeps a retrying job ahead of later FIFO work", async () => {
		const events: string[] = [];
		let firstAttempts = 0;
		const writer = new AsyncDbWriter({ delay: async () => {} });
		writer.enqueue(() => {
			firstAttempts += 1;
			events.push(`first-${firstAttempts}`);
			if (firstAttempts < 3) throw sqliteError("locked", "SQLITE_LOCKED");
		});
		writer.enqueue(() => {
			events.push("second");
		});

		await writer.dispose();
		expect(events).toEqual(["first-1", "first-2", "first-3", "second"]);
		expect(writer.getFailureCount()).toBe(0);
	});

	it("flushes queued jobs during disposal", async () => {
		const writer = new AsyncDbWriter();
		let completed = false;
		writer.enqueue(async () => {
			await Bun.sleep(10);
			completed = true;
		});

		await writer.dispose();
		expect(completed).toBe(true);
		expect(writer.getQueueSize()).toBe(0);
		expect(writer.getFailureCount()).toBe(0);
	});

	it("exposes unhealthy state after a permanent failure", async () => {
		const writer = new AsyncDbWriter();
		writer.enqueue(() => {
			throw new Error("boom");
		});
		await waitFor(() => writer.getFailureCount() === 1);
		await writer.dispose();
		expect(writer.isHealthy()).toBe(false);
	});
});
