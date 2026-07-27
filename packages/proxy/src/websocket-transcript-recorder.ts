import { registerDisposable, websocketTranscriptEvents } from "@ccflare/core";
import type { DatabaseOperations } from "@ccflare/database";
import { Logger } from "@ccflare/logger";
import type {
	Request,
	WebSocketTranscriptChunk,
	WebSocketTranscriptDirection,
	WebSocketTranscriptEntry,
	WebSocketTranscriptFrameType,
} from "@ccflare/types";

const log = new Logger("WebSocketTranscriptRecorder");
const FORMAT_VERSION = 1 as const;
const FLUSH_INTERVAL_MS = 200;
const FLUSH_TARGET_BYTES = 256 * 1024;
const FLUSH_TARGET_ENTRIES = 128;

type RequestWithAccountName = Request & { accountName: string | null };

interface TranscriptState {
	requestId: string;
	nextSequence: number;
	nextEntryToAppend: number;
	nextChunkSequence: number;
	entries: WebSocketTranscriptEntry[];
	pendingEntries: Map<number, WebSocketTranscriptEntry>;
	estimatedBytes: number;
	closing: boolean;
	finalizing: boolean;
}

export interface WebSocketTranscriptRecorderHealth {
	healthy: boolean;
	failureCount: number;
	activeSessions: number;
	bufferedEntries: number;
	lastError: string | null;
}

export class WebSocketTranscriptRecorder {
	private readonly states = new Map<string, TranscriptState>();
	private readonly flushTimer: ReturnType<typeof setInterval>;
	private failureCount = 0;
	private lastError: string | null = null;

	constructor(private readonly dbOps: DatabaseOperations) {
		this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
		this.flushTimer.unref?.();
		registerDisposable(this);
	}

	start(requestId: string): void {
		if (this.states.has(requestId)) return;
		this.states.set(requestId, {
			requestId,
			nextSequence: 1,
			nextEntryToAppend: 1,
			nextChunkSequence: 0,
			entries: [],
			pendingEntries: new Map(),
			estimatedBytes: 0,
			closing: false,
			finalizing: false,
		});
	}

	reserveSequence(requestId: string): number | null {
		const state = this.states.get(requestId);
		return state ? state.nextSequence++ : null;
	}

	recordFrame(
		requestId: string,
		direction: Exclude<WebSocketTranscriptDirection, "system">,
		frameType: WebSocketTranscriptFrameType,
		data: string,
		encoding: "utf8" | "base64",
		observedAt = Date.now(),
	): void {
		const sequence = this.reserveSequence(requestId);
		if (sequence === null) return;
		this.recordReservedFrame(
			requestId,
			sequence,
			direction,
			frameType,
			data,
			encoding,
			observedAt,
		);
	}

	recordReservedFrame(
		requestId: string,
		sequence: number,
		direction: Exclude<WebSocketTranscriptDirection, "system">,
		frameType: WebSocketTranscriptFrameType,
		data: string,
		encoding: "utf8" | "base64",
		observedAt: number,
	): void {
		this.commitReserved(requestId, {
			sequence,
			kind: "frame",
			direction,
			frameType,
			encoding,
			data,
			observedAt,
		});
	}

	recordLifecycle(
		requestId: string,
		name: string,
		details: Record<string, unknown> = {},
		observedAt = Date.now(),
	): void {
		const sequence = this.reserveSequence(requestId);
		if (sequence === null) return;
		this.commitReserved(requestId, {
			sequence,
			kind: "lifecycle",
			direction: "system",
			encoding: "utf8",
			data: JSON.stringify({ name, ...details }),
			observedAt,
		});
	}

	flush(requestId: string): WebSocketTranscriptChunk | null {
		const state = this.states.get(requestId);
		if (!state || state.entries.length === 0) return null;
		const chunk = this.takeChunk(state);
		try {
			this.dbOps.appendWebSocketTranscriptChunks([chunk]);
			this.lastError = null;
		} catch (error) {
			// Restore the entries so a later timer/close can retry without data loss.
			state.entries = chunk.entries.concat(state.entries);
			state.nextChunkSequence = chunk.chunkSequence;
			state.estimatedBytes = Buffer.byteLength(
				JSON.stringify(state.entries),
				"utf8",
			);
			this.recordFailure(requestId, error);
			return null;
		}
		try {
			websocketTranscriptEvents.publish(chunk);
		} catch (error) {
			log.warn("Failed to publish persisted WebSocket transcript chunk", {
				requestId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return chunk;
	}

	finalize(
		requestId: string,
		options: {
			success: boolean;
			errorMessage: string | null;
			responseTimeMs: number;
			usage?: {
				model?: string;
				promptTokens?: number;
				completionTokens?: number;
				totalTokens?: number;
				costUsd?: number;
				inputTokens?: number;
				cacheReadInputTokens?: number;
				cacheCreationInputTokens?: number;
				outputTokens?: number;
				reasoningTokens?: number;
			};
		},
	): RequestWithAccountName | null {
		const state = this.states.get(requestId);
		if (!state) {
			const request = this.dbOps.getRequestWithAccountName(requestId);
			return request?.method === "WS" && request.success === null
				? this.dbOps.finalizeWebSocketRequest(requestId, options)
				: request;
		}
		if (state.finalizing) {
			return this.dbOps.getRequestWithAccountName(requestId);
		}
		state.finalizing = true;
		const finalChunk = state.entries.length > 0 ? this.takeChunk(state) : null;
		let request: RequestWithAccountName | null;
		try {
			request = this.dbOps.finalizeWebSocketRequest(requestId, {
				...options,
				...(finalChunk ? { finalChunk } : {}),
			});
			this.states.delete(requestId);
			this.lastError = null;
		} catch (error) {
			if (finalChunk) {
				state.entries = finalChunk.entries.concat(state.entries);
				state.nextChunkSequence = finalChunk.chunkSequence;
			}
			state.finalizing = false;
			this.recordFailure(requestId, error);
			return null;
		}
		if (finalChunk) {
			try {
				websocketTranscriptEvents.publish(finalChunk);
			} catch (error) {
				log.warn("Failed to publish final WebSocket transcript chunk", {
					requestId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		websocketTranscriptEvents.complete(requestId);
		return request;
	}

	discard(requestId: string): void {
		this.states.delete(requestId);
	}

	prepareFinalize(requestId: string): void {
		const state = this.states.get(requestId);
		if (state) state.closing = true;
	}

	getHealthSnapshot(): WebSocketTranscriptRecorderHealth {
		let bufferedEntries = 0;
		for (const state of this.states.values()) {
			bufferedEntries += state.entries.length;
		}
		return {
			healthy: this.lastError === null,
			failureCount: this.failureCount,
			activeSessions: this.states.size,
			bufferedEntries,
			lastError: this.lastError,
		};
	}

	dispose(): void {
		clearInterval(this.flushTimer);
		const now = Date.now();
		for (const state of Array.from(this.states.values())) {
			this.recordLifecycle(state.requestId, "server_shutdown", {}, now);
			const request = this.dbOps.getRequestWithAccountName(state.requestId);
			this.finalize(state.requestId, {
				success: false,
				errorMessage: "WebSocket interrupted by server shutdown",
				responseTimeMs: Math.max(0, now - (request?.timestamp ?? now)),
			});
		}
	}

	private commitReserved(
		requestId: string,
		entry: WebSocketTranscriptEntry,
	): void {
		const state = this.states.get(requestId);
		if (!state || state.finalizing) return;
		state.pendingEntries.set(entry.sequence, entry);
		while (true) {
			const next = state.pendingEntries.get(state.nextEntryToAppend);
			if (!next) break;
			state.pendingEntries.delete(state.nextEntryToAppend);
			state.nextEntryToAppend += 1;
			state.entries.push(next);
			state.estimatedBytes += Buffer.byteLength(JSON.stringify(next), "utf8");
		}
		if (
			!state.closing &&
			(state.entries.length >= FLUSH_TARGET_ENTRIES ||
				state.estimatedBytes >= FLUSH_TARGET_BYTES)
		) {
			this.flush(requestId);
		}
	}

	private takeChunk(state: TranscriptState): WebSocketTranscriptChunk {
		const entries = state.entries;
		state.entries = [];
		state.estimatedBytes = 0;
		const encoded = Buffer.from(JSON.stringify(entries), "utf8");
		return {
			requestId: state.requestId,
			chunkSequence: state.nextChunkSequence++,
			firstFrameSequence: entries[0].sequence,
			lastFrameSequence: entries[entries.length - 1].sequence,
			startedAt: entries[0].observedAt,
			endedAt: entries[entries.length - 1].observedAt,
			formatVersion: FORMAT_VERSION,
			byteLength: encoded.byteLength,
			entries,
		};
	}

	private flushAll(): void {
		for (const [requestId, state] of this.states) {
			if (!state.closing) this.flush(requestId);
		}
	}

	private recordFailure(requestId: string, error: unknown): void {
		this.failureCount += 1;
		this.lastError = error instanceof Error ? error.message : String(error);
		log.error("Failed to persist WebSocket transcript", {
			requestId,
			error: this.lastError,
		});
	}
}
