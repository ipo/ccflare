import type { WebSocketTranscriptEntry } from "@ccflare/types";

export interface WebSocketTranscriptPresentation {
	label: string;
	known: boolean;
	content: string | null;
	raw: string;
}

function stringifyContent(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return null;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Parse only when a transcript is displayed; stored chunks stay raw. */
export function presentWebSocketTranscriptEntry(
	entry: WebSocketTranscriptEntry,
): WebSocketTranscriptPresentation {
	if (entry.kind === "lifecycle") {
		try {
			const parsed = JSON.parse(entry.data) as Record<string, unknown>;
			return {
				label: typeof parsed.name === "string" ? parsed.name : "Lifecycle",
				known: true,
				content: stringifyContent(parsed),
				raw: entry.data,
			};
		} catch {
			return {
				label: "Lifecycle",
				known: false,
				content: null,
				raw: entry.data,
			};
		}
	}

	if (entry.frameType === "binary") {
		return {
			label: "Binary frame",
			known: false,
			content: null,
			raw: entry.data,
		};
	}

	try {
		const parsed = JSON.parse(entry.data) as Record<string, unknown>;
		const type = typeof parsed.type === "string" ? parsed.type : null;
		if (!type) {
			return {
				label: "JSON frame",
				known: false,
				content: stringifyContent(parsed),
				raw: entry.data,
			};
		}

		switch (type) {
			case "response.create":
				return {
					label: type,
					known: true,
					content: stringifyContent(parsed.input ?? parsed),
					raw: entry.data,
				};
			case "response.output_text.delta":
				return {
					label: type,
					known: true,
					content: stringifyContent(parsed.delta),
					raw: entry.data,
				};
			case "response.created":
			case "response.completed":
			case "response.failed":
			case "response.incomplete":
			case "response.output_item.added":
			case "response.output_item.done":
			case "response.content_part.added":
			case "response.output_text.done":
			case "error":
				return {
					label: type,
					known: true,
					content: stringifyContent(parsed),
					raw: entry.data,
				};
			default:
				return {
					label: type,
					known: false,
					content: stringifyContent(parsed),
					raw: entry.data,
				};
		}
	} catch {
		return {
			label: "Text frame",
			known: false,
			content: entry.data,
			raw: entry.data,
		};
	}
}
