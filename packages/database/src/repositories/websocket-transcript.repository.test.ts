import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { WebSocketTranscriptChunk } from "@ccflare/types";
import { ensureSchema, runMigrations } from "../migrations";
import { RequestRepository } from "./request.repository";
import { WebSocketTranscriptRepository } from "./websocket-transcript.repository";

describe("WebSocketTranscriptRepository", () => {
	let db: Database;
	let requests: RequestRepository;
	let transcripts: WebSocketTranscriptRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		ensureSchema(db);
		runMigrations(db);
		requests = new RequestRepository(db);
		transcripts = new WebSocketTranscriptRepository(db);
		requests.saveMeta(
			"ws-1",
			"WS",
			"/v1/codex/responses",
			"codex",
			"/responses",
			null,
			101,
			1_000,
		);
	});

	afterEach(() => db.close());

	function chunk(
		chunkSequence: number,
		first: number,
		last: number,
	): WebSocketTranscriptChunk {
		const entries = Array.from({ length: last - first + 1 }, (_, index) => ({
			sequence: first + index,
			observedAt: 1_000 + first + index,
			kind: "frame" as const,
			direction: "upstream_to_client" as const,
			frameType: "text" as const,
			encoding: "utf8" as const,
			data: `frame-${first + index}`,
		}));
		return {
			requestId: "ws-1",
			chunkSequence,
			firstFrameSequence: first,
			lastFrameSequence: last,
			startedAt: entries[0].observedAt,
			endedAt: entries.at(-1)?.observedAt ?? entries[0].observedAt,
			formatVersion: 1,
			byteLength: Buffer.byteLength(JSON.stringify(entries)),
			entries,
		};
	}

	it("round-trips ordered chunks and filters a cursor inside a chunk", () => {
		transcripts.appendChunks([chunk(0, 1, 3), chunk(1, 4, 6)]);
		expect(
			transcripts
				.listAfter("ws-1", 2, 10)
				.map((value) => [
					value.chunkSequence,
					value.firstFrameSequence,
					value.lastFrameSequence,
				]),
		).toEqual([
			[0, 1, 3],
			[1, 4, 6],
		]);
		expect(transcripts.getBounds("ws-1")).toEqual({
			firstFrameSequence: 1,
			lastFrameSequence: 6,
		});
	});

	it("makes retried chunk inserts lossless and cascades request deletion", () => {
		const first = chunk(0, 1, 2);
		transcripts.appendChunk(first);
		transcripts.appendChunk(chunk(0, 1, 3));
		const persisted = transcripts.listAfter("ws-1", 0, 10);
		expect(persisted).toHaveLength(1);
		expect(persisted[0].entries.map((entry) => entry.sequence)).toEqual([
			1, 2, 3,
		]);
		db.run(`DELETE FROM requests WHERE id = ?`, ["ws-1"]);
		expect(transcripts.listAfter("ws-1", 0, 10)).toHaveLength(0);
	});
});
