import { describe, expect, it } from "bun:test";
import type { WebSocketTranscriptEntry } from "@ccflare/types";
import { presentWebSocketTranscriptEntry } from "./parse-websocket-transcript";

function entry(data: string): WebSocketTranscriptEntry {
	return {
		sequence: 1,
		observedAt: 1_000,
		kind: "frame",
		direction: "upstream_to_client",
		frameType: "text",
		encoding: "utf8",
		data,
	};
}

describe("presentWebSocketTranscriptEntry", () => {
	it("classifies known events only when presented", () => {
		expect(
			presentWebSocketTranscriptEntry(
				entry('{"type":"response.output_text.delta","delta":"hello"}'),
			),
		).toMatchObject({
			label: "response.output_text.delta",
			known: true,
			content: "hello",
		});
	});

	it("preserves unknown and non-json frames", () => {
		const unknown = '{"type":"response.future_event","value":42}';
		expect(presentWebSocketTranscriptEntry(entry(unknown))).toMatchObject({
			label: "response.future_event",
			known: false,
			raw: unknown,
		});
		expect(presentWebSocketTranscriptEntry(entry("not json"))).toMatchObject({
			label: "Text frame",
			known: false,
			content: "not json",
		});
	});
});
