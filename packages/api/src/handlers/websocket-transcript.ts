import {
	type WebSocketTranscriptLiveEvent,
	websocketTranscriptEvents,
} from "@ccflare/core";
import type { DatabaseOperations } from "@ccflare/database";
import {
	errorResponse,
	jsonResponse,
	NotFound,
	ndjsonResponse,
	sseResponse,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import type {
	WebSocketTranscriptChunk,
	WebSocketTranscriptPage,
} from "@ccflare/types";

const log = new Logger("WebSocketTranscriptHandler");
const EXPORT_PAGE_CHUNKS = 8;

function findWebSocketRequest(dbOps: DatabaseOperations, requestId: string) {
	const request = dbOps.getRequestWithAccountName(requestId);
	return request?.method === "WS" ? request : null;
}

function trimChunkAfter(
	chunk: WebSocketTranscriptChunk,
	after: number,
): WebSocketTranscriptChunk | null {
	const entries = chunk.entries.filter((entry) => entry.sequence > after);
	if (entries.length === 0) return null;
	return {
		...chunk,
		firstFrameSequence: entries[0].sequence,
		lastFrameSequence: entries[entries.length - 1].sequence,
		startedAt: entries[0].observedAt,
		endedAt: entries[entries.length - 1].observedAt,
		byteLength: Buffer.byteLength(JSON.stringify(entries), "utf8"),
		entries,
	};
}

function parseCursor(value: string | null): number {
	const cursor = Number(value ?? 0);
	return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

export function createWebSocketTranscriptExportResponse(
	dbOps: DatabaseOperations,
	requestId: string,
	active: boolean,
): Response {
	const bounds = dbOps.getWebSocketTranscriptSnapshotBounds(requestId);
	const encoder = new TextEncoder();
	const lastChunkSequence = bounds.lastChunkSequence ?? -1;
	let nextChunkSequence = 0;
	let cancelled = false;
	let finished = lastChunkSequence < 0;

	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (cancelled) return;
			try {
				while (!finished) {
					const chunks = dbOps.listWebSocketTranscriptChunkRange(
						requestId,
						nextChunkSequence,
						lastChunkSequence,
						EXPORT_PAGE_CHUNKS,
					);
					if (chunks.length === 0) {
						finished = true;
						controller.close();
						return;
					}

					nextChunkSequence = chunks[chunks.length - 1].chunkSequence + 1;
					const entries = chunks.flatMap((chunk) =>
						chunk.entries.filter(
							(entry) =>
								bounds.lastFrameSequence !== null &&
								entry.sequence <= bounds.lastFrameSequence,
						),
					);
					if (nextChunkSequence > lastChunkSequence) {
						finished = true;
					}
					if (entries.length > 0) {
						controller.enqueue(
							encoder.encode(
								`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
							),
						);
						if (finished) controller.close();
						return;
					}
				}
				controller.close();
			} catch (error) {
				log.error("Failed to stream WebSocket conversation", {
					requestId,
					error: error instanceof Error ? error.message : String(error),
				});
				controller.error(error);
			}
		},
		cancel() {
			cancelled = true;
		},
	});

	const headers: Record<string, string> = {
		"X-Ccflare-Conversation-Kind": "websocket",
		"X-Ccflare-Conversation-Active": String(active),
	};
	if (bounds.firstFrameSequence !== null) {
		headers["X-Ccflare-First-Frame-Sequence"] = String(
			bounds.firstFrameSequence,
		);
	}
	if (bounds.lastFrameSequence !== null) {
		headers["X-Ccflare-Last-Frame-Sequence"] = String(bounds.lastFrameSequence);
	}
	return ndjsonResponse(stream, headers);
}

export function createWebSocketTranscriptPageHandler(
	dbOps: DatabaseOperations,
) {
	return (requestId: string, url: URL): Response => {
		const request = findWebSocketRequest(dbOps, requestId);
		if (!request) {
			return errorResponse(NotFound("WebSocket request not found"));
		}
		const after = parseCursor(url.searchParams.get("after"));
		const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
		const limit = Number.isSafeInteger(requestedLimit)
			? Math.min(500, Math.max(1, requestedLimit))
			: 100;
		const chunks = dbOps
			.listWebSocketTranscriptChunks(requestId, after, limit)
			.map((chunk) => trimChunkAfter(chunk, after))
			.filter((chunk): chunk is WebSocketTranscriptChunk => chunk !== null);
		const bounds = dbOps.getWebSocketTranscriptBounds(requestId);
		const lastReturned = chunks.at(-1)?.lastFrameSequence ?? after;
		const page: WebSocketTranscriptPage = {
			requestId,
			chunks,
			firstFrameSequence: bounds.firstFrameSequence,
			lastFrameSequence: bounds.lastFrameSequence,
			nextCursor:
				bounds.lastFrameSequence !== null &&
				lastReturned < bounds.lastFrameSequence
					? lastReturned
					: null,
			active: request.success === null,
		};
		return jsonResponse(page);
	};
}

export function createWebSocketTranscriptStreamHandler(
	dbOps: DatabaseOperations,
) {
	return (requestId: string, request: Request, url: URL): Response => {
		if (!findWebSocketRequest(dbOps, requestId)) {
			return errorResponse(NotFound("WebSocket request not found"));
		}
		const initialCursor = Math.max(
			parseCursor(url.searchParams.get("after")),
			parseCursor(request.headers.get("last-event-id")),
		);
		let unsubscribe: (() => void) | null = null;
		let cancelled = false;
		let replayTimer: ReturnType<typeof setTimeout> | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				let lastSent = initialCursor;
				let replaying = true;
				const buffered: WebSocketTranscriptLiveEvent[] = [];

				const send = (rawChunk: WebSocketTranscriptChunk) => {
					const chunk = trimChunkAfter(rawChunk, lastSent);
					if (!chunk) return;
					lastSent = chunk.lastFrameSequence;
					controller.enqueue(
						encoder.encode(
							`id: ${lastSent}\ndata: ${JSON.stringify({ type: "chunk", chunk })}\n\n`,
						),
					);
				};

				const complete = () => {
					if (cancelled) return;
					cancelled = true;
					controller.enqueue(
						encoder.encode(`event: complete\ndata: {"type":"complete"}\n\n`),
					);
					unsubscribe?.();
					unsubscribe = null;
					controller.close();
				};
				const dispatchLive = (event: WebSocketTranscriptLiveEvent) => {
					if (event.type === "chunk") send(event.chunk);
					else complete();
				};

				unsubscribe = websocketTranscriptEvents.subscribe(
					requestId,
					(event) => {
						if (replaying) buffered.push(event);
						else dispatchLive(event);
					},
				);

				const finishReplay = () => {
					replaying = false;
					buffered
						.filter(
							(
								event,
							): event is Extract<
								WebSocketTranscriptLiveEvent,
								{ type: "chunk" }
							> => event.type === "chunk",
						)
						.sort(
							(left, right) =>
								left.chunk.chunkSequence - right.chunk.chunkSequence,
						)
						.forEach((event) => {
							send(event.chunk);
						});
					if (
						buffered.some((event) => event.type === "complete") ||
						findWebSocketRequest(dbOps, requestId)?.success !== null
					) {
						complete();
					}
					buffered.length = 0;
				};
				const replayPage = (cursor: number) => {
					if (cancelled) return;
					const chunks = dbOps.listWebSocketTranscriptChunks(
						requestId,
						cursor,
						100,
					);
					for (const chunk of chunks) send(chunk);
					const next = chunks.at(-1)?.lastFrameSequence ?? cursor;
					if (chunks.length < 100 || next <= cursor) {
						finishReplay();
						return;
					}
					replayTimer = setTimeout(() => replayPage(next), 0);
					replayTimer.unref?.();
				};
				replayPage(initialCursor);
			},
			cancel() {
				cancelled = true;
				if (replayTimer) clearTimeout(replayTimer);
				unsubscribe?.();
				unsubscribe = null;
			},
		});
		return sseResponse(stream);
	};
}
