import type {
	WebSocketTranscriptChunk,
	WebSocketTranscriptEntry,
} from "@ccflare/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

function mergeEntries(
	current: WebSocketTranscriptEntry[],
	chunks: WebSocketTranscriptChunk[],
): WebSocketTranscriptEntry[] {
	const bySequence = new Map(current.map((entry) => [entry.sequence, entry]));
	for (const chunk of chunks) {
		for (const entry of chunk.entries) bySequence.set(entry.sequence, entry);
	}
	return Array.from(bySequence.values()).sort(
		(left, right) => left.sequence - right.sequence,
	);
}

export function useWebSocketTranscript(requestId: string, enabled: boolean) {
	const [entries, setEntries] = useState<WebSocketTranscriptEntry[]>([]);
	const [loading, setLoading] = useState(enabled);
	const [error, setError] = useState<Error | null>(null);
	const [active, setActive] = useState(false);
	const lastSequenceRef = useRef(0);

	const merge = useCallback((chunks: WebSocketTranscriptChunk[]) => {
		setEntries((current) => mergeEntries(current, chunks));
		for (const chunk of chunks) {
			lastSequenceRef.current = Math.max(
				lastSequenceRef.current,
				chunk.lastFrameSequence,
			);
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		let disposed = false;
		let eventSource: EventSource | null = null;
		let reconcileTimer: ReturnType<typeof setInterval> | null = null;
		setEntries([]);
		lastSequenceRef.current = 0;
		setLoading(true);
		setError(null);

		const start = async () => {
			try {
				const page = await api.getWebSocketTranscript(requestId, 0);
				if (disposed) return;
				merge(page.chunks);
				setActive(page.active);
				setLoading(false);
				if (disposed || (!page.active && page.nextCursor === null)) return;
				eventSource = new EventSource(
					`/api/requests/${encodeURIComponent(requestId)}/transcript/stream?after=${lastSequenceRef.current}`,
				);
				eventSource.addEventListener("message", (event) => {
					try {
						const parsed = JSON.parse(event.data) as {
							type: string;
							chunk?: WebSocketTranscriptChunk;
						};
						if (parsed.type === "chunk" && parsed.chunk) merge([parsed.chunk]);
					} catch (cause) {
						setError(cause instanceof Error ? cause : new Error(String(cause)));
					}
				});
				eventSource.addEventListener("complete", () => {
					setActive(false);
					eventSource?.close();
					eventSource = null;
					if (reconcileTimer) {
						clearInterval(reconcileTimer);
						reconcileTimer = null;
					}
				});
				eventSource.addEventListener("error", () => {
					// EventSource reconnects automatically with Last-Event-ID. The periodic
					// snapshot below remains the reconciliation path.
				});
				reconcileTimer = setInterval(async () => {
					try {
						const page = await api.getWebSocketTranscript(
							requestId,
							lastSequenceRef.current,
						);
						if (!disposed) {
							merge(page.chunks);
							setActive(page.active);
						}
					} catch {
						// The live stream remains primary; the next interval retries.
					}
				}, 5_000);
			} catch (cause) {
				if (!disposed) {
					setLoading(false);
					setError(cause instanceof Error ? cause : new Error(String(cause)));
				}
			}
		};

		void start();
		return () => {
			disposed = true;
			eventSource?.close();
			if (reconcileTimer) clearInterval(reconcileTimer);
		};
	}, [enabled, merge, requestId]);

	return { entries, loading, error, active };
}
