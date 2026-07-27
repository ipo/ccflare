import { EventEmitter } from "node:events";
import type { WebSocketTranscriptChunk } from "@ccflare/types";

export type WebSocketTranscriptLiveEvent =
	| { type: "chunk"; chunk: WebSocketTranscriptChunk }
	| { type: "complete"; requestId: string };

class WebSocketTranscriptEventBus extends EventEmitter {
	publish(chunk: WebSocketTranscriptChunk): void {
		this.publishEvent(chunk.requestId, { type: "chunk", chunk });
	}

	complete(requestId: string): void {
		this.publishEvent(requestId, { type: "complete", requestId });
	}

	subscribe(
		requestId: string,
		listener: (event: WebSocketTranscriptLiveEvent) => void,
	): () => void {
		this.on(requestId, listener);
		return () => this.off(requestId, listener);
	}

	private publishEvent(
		requestId: string,
		event: WebSocketTranscriptLiveEvent,
	): void {
		for (const listener of this.rawListeners(requestId)) {
			try {
				(listener as (value: WebSocketTranscriptLiveEvent) => void)(event);
			} catch {
				// A disconnected/slow observer must not interfere with persistence or
				// delivery to other transcript viewers.
			}
		}
	}
}

export const websocketTranscriptEvents = new WebSocketTranscriptEventBus();
