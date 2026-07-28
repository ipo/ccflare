import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { websocketTranscriptEvents } from "@ccflare/core";
import { DatabaseOperations } from "@ccflare/database";
import type {
	WebSocketTranscriptChunk,
	WebSocketTranscriptEntry,
} from "@ccflare/types";
import {
	createRequestsConversationHandler,
	createRequestsDetailHandler,
} from "./requests";
import {
	createWebSocketTranscriptPageHandler,
	createWebSocketTranscriptStreamHandler,
} from "./websocket-transcript";

describe("WebSocket transcript handlers", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:");
		dbOps.saveRequestMeta(
			"ws-handler",
			"WS",
			"/v1/codex/responses",
			"codex",
			"/responses",
			null,
			101,
			1_000,
		);
	});

	afterEach(() => {
		websocketTranscriptEvents.removeAllListeners("ws-handler");
		dbOps.close();
	});

	it("keeps metadata-only websocket requests visible in request detail", async () => {
		const response = createRequestsDetailHandler(dbOps)(10);
		const payloads = (await response.json()) as Array<{
			id: string;
			meta: { transport: { pending?: boolean } };
		}>;
		expect(payloads).toEqual([
			expect.objectContaining({
				id: "ws-handler",
				meta: expect.objectContaining({
					transport: expect.objectContaining({ pending: true }),
				}),
			}),
		]);
	});

	function createChunkFromEntries(
		chunkSequence: number,
		entries: WebSocketTranscriptEntry[],
	): WebSocketTranscriptChunk {
		return {
			requestId: "ws-handler",
			chunkSequence,
			firstFrameSequence: entries[0].sequence,
			lastFrameSequence: entries.at(-1)?.sequence ?? entries[0].sequence,
			startedAt: entries[0].observedAt,
			endedAt: entries.at(-1)?.observedAt ?? entries[0].observedAt,
			formatVersion: 1,
			byteLength: Buffer.byteLength(JSON.stringify(entries)),
			entries,
		};
	}

	function createChunk(
		firstSequence: number,
		lastSequence: number,
		chunkSequence = 0,
	): WebSocketTranscriptChunk {
		return createChunkFromEntries(
			chunkSequence,
			Array.from({ length: lastSequence - firstSequence + 1 }, (_, index) => {
				const sequence = firstSequence + index;
				return {
					sequence,
					observedAt: 1_000 + sequence,
					kind: "frame" as const,
					direction: "client_to_upstream" as const,
					frameType: "text" as const,
					encoding: "utf8" as const,
					data: `frame-${sequence}`,
				};
			}),
		);
	}

	async function readNdjson(
		response: Response,
	): Promise<WebSocketTranscriptEntry[]> {
		const text = await response.text();
		return text
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as WebSocketTranscriptEntry);
	}

	it("returns ordered chunks and trims entries before a frame cursor", async () => {
		const entries = [1, 2, 3].map((sequence) => ({
			sequence,
			observedAt: 1_000 + sequence,
			kind: "frame" as const,
			direction: "client_to_upstream" as const,
			frameType: "text" as const,
			encoding: "utf8" as const,
			data: `frame-${sequence}`,
		}));
		const chunk: WebSocketTranscriptChunk = {
			requestId: "ws-handler",
			chunkSequence: 0,
			firstFrameSequence: 1,
			lastFrameSequence: 3,
			startedAt: 1_001,
			endedAt: 1_003,
			formatVersion: 1,
			byteLength: Buffer.byteLength(JSON.stringify(entries)),
			entries,
		};
		dbOps.appendWebSocketTranscriptChunks([chunk]);
		const response = createWebSocketTranscriptPageHandler(dbOps)(
			"ws-handler",
			new URL("http://localhost/api/requests/ws-handler/transcript?after=1"),
		);
		const page = (await response.json()) as {
			chunks: WebSocketTranscriptChunk[];
			active: boolean;
		};
		expect(page.active).toBe(true);
		expect(page.chunks[0].entries.map((entry) => entry.sequence)).toEqual([
			2, 3,
		]);
	});

	it("exports a lossless ordered NDJSON conversation across chunk pages", async () => {
		const specialEntries: WebSocketTranscriptEntry[] = [
			{
				sequence: 1,
				observedAt: 1_001,
				kind: "lifecycle",
				direction: "system",
				encoding: "utf8",
				data: '{"name":"connection_open"}',
			},
			{
				sequence: 2,
				observedAt: 1_002,
				kind: "frame",
				direction: "upstream_to_client",
				frameType: "text",
				encoding: "utf8",
				data: "not-json",
			},
			{
				sequence: 3,
				observedAt: 1_003,
				kind: "frame",
				direction: "client_to_upstream",
				frameType: "binary",
				encoding: "base64",
				data: "AQIDBA==",
			},
		];
		const chunks = [createChunkFromEntries(0, specialEntries)];
		for (let sequence = 4; sequence <= 12; sequence++) {
			chunks.push(createChunk(sequence, sequence, sequence - 3));
		}
		dbOps.appendWebSocketTranscriptChunks(chunks);

		const response = createRequestsConversationHandler(dbOps)("ws-handler");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"application/x-ndjson",
		);
		expect(response.headers.get("x-ccflare-conversation-kind")).toBe(
			"websocket",
		);
		expect(await readNdjson(response)).toEqual(
			chunks.flatMap((chunk) => chunk.entries),
		);
	});

	it("exports a finite snapshot for an active websocket", async () => {
		dbOps.appendWebSocketTranscriptChunks([createChunk(1, 1, 0)]);
		const response = createRequestsConversationHandler(dbOps)("ws-handler");
		dbOps.appendWebSocketTranscriptChunks([createChunk(2, 2, 1)]);

		expect(response.headers.get("x-ccflare-conversation-active")).toBe("true");
		expect(response.headers.get("x-ccflare-last-frame-sequence")).toBe("1");
		expect((await readNdjson(response)).map((entry) => entry.sequence)).toEqual(
			[1],
		);
	});

	it("stops exporting transcript pages when the request aborts", async () => {
		dbOps.appendWebSocketTranscriptChunks(
			Array.from({ length: 12 }, (_, index) =>
				createChunk(index + 1, index + 1, index),
			),
		);
		const abortController = new AbortController();
		const response = createRequestsConversationHandler(dbOps)(
			"ws-handler",
			new Request("http://localhost/conversation", {
				signal: abortController.signal,
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected conversation response body");

		const firstPage = await reader.read();
		expect(firstPage.done).toBe(false);
		abortController.abort();
		expect((await reader.read()).done).toBe(true);
	});

	it("streams an uncapped multi-megabyte websocket conversation", async () => {
		const payload = "x".repeat(128 * 1024);
		const chunks = Array.from({ length: 24 }, (_, index) => {
			const sequence = index + 1;
			return createChunkFromEntries(index, [
				{
					sequence,
					observedAt: 1_000 + sequence,
					kind: "frame",
					direction: "upstream_to_client",
					frameType: "text",
					encoding: "utf8",
					data: payload,
				},
			]);
		});
		dbOps.appendWebSocketTranscriptChunks(chunks);
		const response = createRequestsConversationHandler(dbOps)("ws-handler");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected conversation response body");
		const decoder = new TextDecoder();
		let reads = 0;
		let text = "";
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			reads += 1;
			text += decoder.decode(result.value, { stream: true });
		}
		text += decoder.decode();
		const entries = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as WebSocketTranscriptEntry);
		expect(reads).toBeGreaterThan(1);
		expect(entries).toHaveLength(24);
		expect(entries.every((entry) => entry.data === payload)).toBe(true);
	});

	it("unsubscribes before events can reach an aborted response", async () => {
		dbOps.appendWebSocketTranscriptChunks([createChunk(1, 1, 0)]);
		const abortController = new AbortController();
		const baseline = websocketTranscriptEvents.listenerCount("ws-handler");
		const response = createWebSocketTranscriptStreamHandler(dbOps)(
			"ws-handler",
			new Request("http://localhost/stream", {
				signal: abortController.signal,
			}),
			new URL("http://localhost/stream"),
		);
		expect(websocketTranscriptEvents.listenerCount("ws-handler")).toBe(
			baseline + 1,
		);

		abortController.abort();
		expect(websocketTranscriptEvents.listenerCount("ws-handler")).toBe(
			baseline,
		);
		expect(() => {
			websocketTranscriptEvents.publish(createChunk(2, 2, 1));
			websocketTranscriptEvents.complete("ws-handler");
		}).not.toThrow();
		await response.body?.cancel();
	});

	it("unsubscribes before events can reach a cancelled response body", async () => {
		dbOps.appendWebSocketTranscriptChunks([createChunk(1, 1, 0)]);
		const baseline = websocketTranscriptEvents.listenerCount("ws-handler");
		const response = createWebSocketTranscriptStreamHandler(dbOps)(
			"ws-handler",
			new Request("http://localhost/stream"),
			new URL("http://localhost/stream"),
		);
		expect(websocketTranscriptEvents.listenerCount("ws-handler")).toBe(
			baseline + 1,
		);

		await response.body?.cancel();
		expect(websocketTranscriptEvents.listenerCount("ws-handler")).toBe(
			baseline,
		);
		expect(() => {
			websocketTranscriptEvents.publish(createChunk(2, 2, 1));
			websocketTranscriptEvents.complete("ws-handler");
		}).not.toThrow();
	});

	it("stops paginated replay work when the request aborts", async () => {
		dbOps.appendWebSocketTranscriptChunks(
			Array.from({ length: 9 }, (_, index) =>
				createChunk(index + 1, index + 1, index),
			),
		);
		const abortController = new AbortController();
		const baseline = websocketTranscriptEvents.listenerCount("ws-handler");
		const response = createWebSocketTranscriptStreamHandler(dbOps)(
			"ws-handler",
			new Request("http://localhost/stream", {
				signal: abortController.signal,
			}),
			new URL("http://localhost/stream"),
		);

		abortController.abort();
		await Bun.sleep(5);
		expect(websocketTranscriptEvents.listenerCount("ws-handler")).toBe(
			baseline,
		);
		await response.body?.cancel();
	});

	it("replays persisted chunks, streams new chunks, and completes", async () => {
		const first = createChunk(1, 2, 0);
		dbOps.appendWebSocketTranscriptChunks([first]);
		const response = createWebSocketTranscriptStreamHandler(dbOps)(
			"ws-handler",
			new Request("http://localhost/stream"),
			new URL("http://localhost/stream?after=0"),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected transcript response body");
		const decoder = new TextDecoder();
		const replay = decoder.decode((await reader.read()).value);
		expect(replay).toContain("id: 2");

		const second = createChunk(3, 3, 1);
		dbOps.appendWebSocketTranscriptChunks([second]);
		websocketTranscriptEvents.publish(second);
		const live = decoder.decode((await reader.read()).value);
		expect(live).toContain("id: 3");

		dbOps.finalizeWebSocketRequest("ws-handler", {
			success: true,
			errorMessage: null,
			responseTimeMs: 100,
		});
		websocketTranscriptEvents.complete("ws-handler");
		const complete = decoder.decode((await reader.read()).value);
		expect(complete).toContain("event: complete");
		expect((await reader.read()).done).toBe(true);
	});
});
