export type WebSocketTranscriptDirection =
	| "client_to_upstream"
	| "upstream_to_client"
	| "system";

export type WebSocketTranscriptFrameType = "text" | "binary";

export type WebSocketTranscriptEntryKind = "frame" | "lifecycle";

/**
 * Provider-neutral record of one WebSocket observation at the proxy boundary.
 * `data` is raw UTF-8 text or base64-encoded binary data; semantic parsing is
 * deliberately deferred until display time.
 */
export interface WebSocketTranscriptEntry {
	sequence: number;
	observedAt: number;
	kind: WebSocketTranscriptEntryKind;
	direction: WebSocketTranscriptDirection;
	frameType?: WebSocketTranscriptFrameType;
	encoding: "utf8" | "base64";
	data: string;
}

export interface WebSocketTranscriptChunk {
	requestId: string;
	chunkSequence: number;
	firstFrameSequence: number;
	lastFrameSequence: number;
	startedAt: number;
	endedAt: number;
	formatVersion: 1;
	byteLength: number;
	entries: WebSocketTranscriptEntry[];
}

export interface WebSocketTranscriptPage {
	requestId: string;
	chunks: WebSocketTranscriptChunk[];
	firstFrameSequence: number | null;
	lastFrameSequence: number | null;
	nextCursor: number | null;
	active: boolean;
}

export function isWebSocketTranscriptEntry(
	value: unknown,
): value is WebSocketTranscriptEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.sequence === "number" &&
		Number.isFinite(entry.sequence) &&
		typeof entry.observedAt === "number" &&
		Number.isFinite(entry.observedAt) &&
		(entry.kind === "frame" || entry.kind === "lifecycle") &&
		(entry.direction === "client_to_upstream" ||
			entry.direction === "upstream_to_client" ||
			entry.direction === "system") &&
		(entry.frameType === undefined ||
			entry.frameType === "text" ||
			entry.frameType === "binary") &&
		(entry.encoding === "utf8" || entry.encoding === "base64") &&
		typeof entry.data === "string"
	);
}
