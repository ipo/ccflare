import type {
	WebSocketTranscriptChunk,
	WebSocketTranscriptEntry,
} from "@ccflare/types";
import { BaseRepository } from "./base.repository";

export const WEBSOCKET_TRANSCRIPT_DELETE_BATCH_SIZE = 500;

interface WebSocketTranscriptChunkRow {
	request_id: string;
	chunk_sequence: number;
	first_frame_sequence: number;
	last_frame_sequence: number;
	started_at: number;
	ended_at: number;
	format_version: number;
	data: Uint8Array | Buffer | string;
	byte_length: number;
}

function decodeChunk(
	row: WebSocketTranscriptChunkRow,
): WebSocketTranscriptChunk {
	const encoded =
		typeof row.data === "string"
			? row.data
			: Buffer.from(row.data).toString("utf8");
	const entries = JSON.parse(encoded) as WebSocketTranscriptEntry[];
	return {
		requestId: row.request_id,
		chunkSequence: row.chunk_sequence,
		firstFrameSequence: row.first_frame_sequence,
		lastFrameSequence: row.last_frame_sequence,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		formatVersion: 1,
		byteLength: row.byte_length,
		entries,
	};
}

export class WebSocketTranscriptRepository extends BaseRepository<WebSocketTranscriptChunk> {
	appendChunk(chunk: WebSocketTranscriptChunk): void {
		const data = Buffer.from(JSON.stringify(chunk.entries), "utf8");
		this.run(
			`
				INSERT INTO websocket_transcript_chunks (
					request_id, chunk_sequence, first_frame_sequence,
					last_frame_sequence, started_at, ended_at,
					format_version, data, byte_length
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(request_id, chunk_sequence) DO UPDATE SET
					first_frame_sequence = excluded.first_frame_sequence,
					last_frame_sequence = excluded.last_frame_sequence,
					started_at = excluded.started_at,
					ended_at = excluded.ended_at,
					format_version = excluded.format_version,
					data = excluded.data,
					byte_length = excluded.byte_length
			`,
			[
				chunk.requestId,
				chunk.chunkSequence,
				chunk.firstFrameSequence,
				chunk.lastFrameSequence,
				chunk.startedAt,
				chunk.endedAt,
				chunk.formatVersion,
				data,
				data.byteLength,
			],
		);
	}

	appendChunks(chunks: WebSocketTranscriptChunk[]): void {
		if (chunks.length === 0) return;
		this.db.run("BEGIN");
		try {
			for (const chunk of chunks) this.appendChunk(chunk);
			this.db.run("COMMIT");
		} catch (error) {
			this.db.run("ROLLBACK");
			throw error;
		}
	}

	listAfter(
		requestId: string,
		afterFrameSequence: number,
		limit: number,
	): WebSocketTranscriptChunk[] {
		return this.query<WebSocketTranscriptChunkRow>(
			`
				SELECT * FROM websocket_transcript_chunks
				WHERE request_id = ? AND last_frame_sequence > ?
				ORDER BY chunk_sequence ASC
				LIMIT ?
			`,
			[requestId, afterFrameSequence, limit],
		).map(decodeChunk);
	}

	listChunkRange(
		requestId: string,
		fromChunkSequence: number,
		throughChunkSequence: number,
		limit: number,
	): WebSocketTranscriptChunk[] {
		return this.query<WebSocketTranscriptChunkRow>(
			`
				SELECT * FROM websocket_transcript_chunks
				WHERE request_id = ?
					AND chunk_sequence >= ?
					AND chunk_sequence <= ?
				ORDER BY chunk_sequence ASC
				LIMIT ?
			`,
			[requestId, fromChunkSequence, throughChunkSequence, limit],
		).map(decodeChunk);
	}

	getSnapshotBounds(requestId: string): {
		firstFrameSequence: number | null;
		lastFrameSequence: number | null;
		lastChunkSequence: number | null;
	} {
		const row = this.get<{
			first_sequence: number | null;
			last_sequence: number | null;
			last_chunk_sequence: number | null;
		}>(
			`
				SELECT MIN(first_frame_sequence) AS first_sequence,
					MAX(last_frame_sequence) AS last_sequence,
					MAX(chunk_sequence) AS last_chunk_sequence
				FROM websocket_transcript_chunks
				WHERE request_id = ?
			`,
			[requestId],
		);
		return {
			firstFrameSequence: row?.first_sequence ?? null,
			lastFrameSequence: row?.last_sequence ?? null,
			lastChunkSequence: row?.last_chunk_sequence ?? null,
		};
	}

	getBounds(requestId: string): {
		firstFrameSequence: number | null;
		lastFrameSequence: number | null;
	} {
		const { firstFrameSequence, lastFrameSequence } =
			this.getSnapshotBounds(requestId);
		return { firstFrameSequence, lastFrameSequence };
	}

	deleteClosedOlderThan(cutoffTs: number): number {
		return this.runWithChanges(
			`
				DELETE FROM websocket_transcript_chunks
				WHERE request_id IN (
					SELECT id FROM requests
					WHERE method = 'WS'
						AND success IS NOT NULL
						AND timestamp + COALESCE(response_time_ms, 0) < ?
				)
			`,
			[cutoffTs],
		);
	}

	deleteClosedOlderThanBatch(
		cutoffTs: number,
		limit = WEBSOCKET_TRANSCRIPT_DELETE_BATCH_SIZE,
	): number {
		return this.runWithChanges(
			`
				DELETE FROM websocket_transcript_chunks
				WHERE (request_id, chunk_sequence) IN (
					SELECT chunks.request_id, chunks.chunk_sequence
					FROM requests
					JOIN websocket_transcript_chunks AS chunks
						ON chunks.request_id = requests.id
					WHERE requests.timestamp < ?
						AND requests.method = 'WS'
						AND requests.success IS NOT NULL
						AND requests.timestamp
							+ COALESCE(requests.response_time_ms, 0) < ?
					LIMIT ?
				)
			`,
			[cutoffTs, cutoffTs, limit],
		);
	}
}
