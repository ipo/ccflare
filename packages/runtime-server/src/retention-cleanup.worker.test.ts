import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@ccflare/database";
import type {
	RetentionWorkerIncomingMessage,
	RetentionWorkerOutgoingMessage,
} from "./retention-worker-messages";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { recursive: true, force: true });
	}
});

function nextMessage(
	worker: Worker,
	predicate: (message: RetentionWorkerOutgoingMessage) => boolean,
): Promise<RetentionWorkerOutgoingMessage> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Timed out waiting for retention worker")),
			5_000,
		);
		worker.onmessage = (
			event: MessageEvent<RetentionWorkerOutgoingMessage>,
		) => {
			if (!predicate(event.data)) return;
			clearTimeout(timeout);
			resolve(event.data);
		};
		worker.onerror = (event) => {
			clearTimeout(timeout);
			reject(event.error ?? new Error(event.message));
		};
	});
}

describe("retention cleanup worker", () => {
	test("backs off from a foreground writer without blocking the main event loop", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "ccflare-retention-worker-"));
		tempDirs.push(tempDir);
		const dbPath = join(tempDir, "ccflare.db");
		const primary = new DatabaseOperations(dbPath);
		primary.getDatabase().run(
			`INSERT INTO requests (id, timestamp, method, path, provider)
			 VALUES ('old', 0, 'POST', '/', 'openai')`,
		);
		const worker = new Worker(
			new URL("./retention-cleanup.worker.ts", import.meta.url).href,
			{ smol: true },
		);

		try {
			await nextMessage(worker, (message) => message.type === "ready");
			primary.getDatabase().exec("BEGIN IMMEDIATE");
			worker.postMessage({
				type: "run",
				runId: "contended",
				dbPath,
				payloadRetentionMs: 1,
				requestRetentionMs: 1,
				now: 10_000,
			} satisfies RetentionWorkerIncomingMessage);

			let timerFired = false;
			await new Promise<void>((resolve) =>
				setTimeout(() => {
					timerFired = true;
					resolve();
				}, 20),
			);
			expect(timerFired).toBeTrue();
			primary.getDatabase().exec("ROLLBACK");

			const completed = await nextMessage(
				worker,
				(message) => message.type === "complete",
			);
			expect(completed).toMatchObject({
				type: "complete",
				runId: "contended",
				totals: { removedRequests: 1 },
			});
			worker.postMessage({
				type: "shutdown",
			} satisfies RetentionWorkerIncomingMessage);
			await nextMessage(
				worker,
				(message) => message.type === "shutdown-complete",
			);
		} finally {
			try {
				primary.getDatabase().exec("ROLLBACK");
			} catch {}
			worker.terminate();
			primary.close();
		}
	});
});
