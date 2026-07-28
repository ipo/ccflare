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
const LIVE_REPLAY_PAGE_CHUNKS = 8;

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
	abortSignal?: AbortSignal,
): Response {
	const bounds = dbOps.getWebSocketTranscriptSnapshotBounds(requestId);
	const encoder = new TextEncoder();
	const lastChunkSequence = bounds.lastChunkSequence ?? -1;
	let nextChunkSequence = 0;
	let exhausted = lastChunkSequence < 0;
	let terminated = false;

	const terminate = () => {
		if (terminated) return;
		terminated = true;
		abortSignal?.removeEventListener("abort", terminate);
	};
	if (abortSignal?.aborted) terminate();
	else abortSignal?.addEventListener("abort", terminate, { once: true });

	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (terminated) {
				try {
					controller.close();
				} catch {
					// Bun may already have detached an aborted response stream.
				}
				return;
			}

			let encoded: Uint8Array | null = null;
			try {
				while (!exhausted && encoded === null) {
					const chunks = dbOps.listWebSocketTranscriptChunkRange(
						requestId,
						nextChunkSequence,
						lastChunkSequence,
						EXPORT_PAGE_CHUNKS,
					);
					if (chunks.length === 0) {
						exhausted = true;
						break;
					}

					nextChunkSequence = chunks[chunks.length - 1].chunkSequence + 1;
					const entries = chunks.flatMap((chunk) =>
						chunk.entries.filter(
							(entry) =>
								bounds.lastFrameSequence !== null &&
								entry.sequence <= bounds.lastFrameSequence,
						),
					);
					exhausted = nextChunkSequence > lastChunkSequence;
					if (entries.length > 0) {
						encoded = encoder.encode(
							`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
						);
					}
				}
			} catch (error) {
				log.error("Failed to stream WebSocket conversation", {
					requestId,
					error: error instanceof Error ? error.message : String(error),
				});
				terminate();
				try {
					controller.error(error);
				} catch {
					// Bun may already have detached the response stream after an abort.
				}
				return;
			}

			if (terminated) return;
			if (encoded) {
				try {
					controller.enqueue(encoded);
				} catch (error) {
					terminate();
					log.debug("Stopped WebSocket conversation export after disconnect", {
						requestId,
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
			if (exhausted) {
				terminate();
				try {
					controller.close();
				} catch {
					// The consumer may have cancelled between the final enqueue and close.
				}
			}
		},
		cancel() {
			terminate();
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
		let terminal = false;
		let pullReplay: (() => void) | null = null;
		const buffered: WebSocketTranscriptLiveEvent[] = [];
		const onAbort = () => cleanup();
		const cleanup = (): boolean => {
			if (terminal) return false;
			terminal = true;
			pullReplay = null;
			unsubscribe?.();
			unsubscribe = null;
			buffered.length = 0;
			request.signal.removeEventListener("abort", onAbort);
			return true;
		};
		if (request.signal.aborted) cleanup();
		else request.signal.addEventListener("abort", onAbort, { once: true });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				if (terminal) {
					try {
						controller.close();
					} catch {
						// Bun may already have detached an aborted response stream.
					}
					return;
				}
				const encoder = new TextEncoder();
				let lastSent = initialCursor;
				let replaying = true;

				const send = (rawChunk: WebSocketTranscriptChunk): boolean => {
					if (terminal) return false;
					const chunk = trimChunkAfter(rawChunk, lastSent);
					if (!chunk) return true;
					try {
						controller.enqueue(
							encoder.encode(
								`id: ${chunk.lastFrameSequence}\ndata: ${JSON.stringify({ type: "chunk", chunk })}\n\n`,
							),
						);
						lastSent = chunk.lastFrameSequence;
						return true;
					} catch (error) {
						cleanup();
						log.debug("Stopped WebSocket transcript stream after disconnect", {
							requestId,
							error: error instanceof Error ? error.message : String(error),
						});
						return false;
					}
				};

				const complete = () => {
					if (!cleanup()) return;
					try {
						controller.enqueue(
							encoder.encode(`event: complete\ndata: {"type":"complete"}\n\n`),
						);
						controller.close();
					} catch (error) {
						log.debug(
							"WebSocket transcript stream detached during completion",
							{
								requestId,
								error: error instanceof Error ? error.message : String(error),
							},
						);
					}
				};
				const dispatchLive = (event: WebSocketTranscriptLiveEvent) => {
					if (terminal) return;
					if (event.type === "chunk") send(event.chunk);
					else complete();
				};

				unsubscribe = websocketTranscriptEvents.subscribe(
					requestId,
					(event) => {
						if (terminal) return;
						if (replaying) buffered.push(event);
						else dispatchLive(event);
					},
				);

				const finishReplay = () => {
					if (terminal) return;
					pullReplay = null;
					replaying = false;
					const replayed = buffered
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
						.every((event) => send(event.chunk));
					if (!replayed || terminal) return;
					if (
						buffered.some((event) => event.type === "complete") ||
						findWebSocketRequest(dbOps, requestId)?.success !== null
					) {
						complete();
						return;
					}
					buffered.length = 0;
				};
				let replayCursor = initialCursor;
				const replayPage = () => {
					if (terminal) return;
					try {
						const cursor = replayCursor;
						const chunks = dbOps.listWebSocketTranscriptChunks(
							requestId,
							cursor,
							LIVE_REPLAY_PAGE_CHUNKS,
						);
						if (!chunks.every((chunk) => send(chunk)) || terminal) return;
						const next = chunks.at(-1)?.lastFrameSequence ?? cursor;
						if (chunks.length < LIVE_REPLAY_PAGE_CHUNKS || next <= cursor) {
							finishReplay();
							return;
						}
						replayCursor = next;
					} catch (error) {
						log.error("Failed to replay WebSocket transcript", {
							requestId,
							error: error instanceof Error ? error.message : String(error),
						});
						if (cleanup()) {
							try {
								controller.close();
							} catch {
								// Bun may already have detached the response stream.
							}
						}
					}
				};
				pullReplay = replayPage;
			},
			pull() {
				pullReplay?.();
			},
			cancel() {
				cleanup();
			},
		});
		return sseResponse(stream);
	};
}
