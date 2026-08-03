import * as nodeCrypto from "node:crypto";
import { sanitizeProxyHeaders } from "@ccflare/http";
import { isRecord } from "@ccflare/types";
import type {
	AnthropicToChatStreamState,
	AnthropicUsage,
	JsonRecord,
	OpenAIUsage,
	ResponsesToChatStreamState,
	SseFrame,
	SseTransformState,
} from "../types";

export function asArray<T>(value: T | T[] | undefined | null): T[] {
	if (Array.isArray(value)) return value;
	return value == null ? [] : [value];
}

export function textContentFromUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (!Array.isArray(value)) {
		return "";
	}

	return value
		.map((item) => {
			if (typeof item === "string") return item;
			if (isRecord(item) && typeof item.text === "string") {
				return item.text;
			}
			return "";
		})
		.filter(Boolean)
		.join("");
}

const ANTHROPIC_46_MODEL_RE = /claude-.*(?:4[-._]?6)/i;
const ANTHROPIC_OPUS_46_MODEL_RE =
	/claude-opus-.*(?:4[-._]?6)|claude-opus(?:[-._]?4[-._]?6)/i;

const LEVEL_TO_BUDGET: Record<string, number> = {
	none: 0,
	auto: -1,
	minimal: 512,
	low: 1024,
	medium: 8192,
	high: 24576,
	xhigh: 32768,
	max: 128000,
};

export function normalizeReasoningEffort(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim().toLowerCase();
	return normalized ? normalized : undefined;
}

export function convertLevelToBudget(level: unknown): number | undefined {
	const normalized = normalizeReasoningEffort(level);
	return normalized ? LEVEL_TO_BUDGET[normalized] : undefined;
}

export function convertBudgetToReasoningEffort(
	budget: unknown,
): string | undefined {
	if (typeof budget !== "number" || Number.isNaN(budget) || budget < -1) {
		return undefined;
	}
	if (budget === -1) return "auto";
	if (budget === 0) return "none";
	if (budget <= 512) return "minimal";
	if (budget <= 1024) return "low";
	if (budget <= 8192) return "medium";
	if (budget <= 24576) return "high";
	return "xhigh";
}

export function claudeModelSupportsAdaptive(model: string): boolean {
	return ANTHROPIC_46_MODEL_RE.test(model);
}

export function claudeModelSupportsMax(model: string): boolean {
	return ANTHROPIC_OPUS_46_MODEL_RE.test(model);
}

export function mapToClaudeEffort(
	level: unknown,
	supportsMax: boolean,
): string | undefined {
	const normalized = normalizeReasoningEffort(level);
	switch (normalized) {
		case "minimal":
			return "low";
		case "low":
		case "medium":
		case "high":
			return normalized;
		case "xhigh":
		case "max":
			return supportsMax ? "max" : "high";
		case "auto":
			return "high";
		default:
			return undefined;
	}
}

export function mapClaudeEffortToReasoningEffort(
	value: unknown,
): string | undefined {
	const normalized = normalizeReasoningEffort(value);
	switch (normalized) {
		case "low":
		case "medium":
		case "high":
			return normalized;
		case "max":
			return "xhigh";
		default:
			return undefined;
	}
}

export function maybeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export function anthropicStopToOpenAIFinish(
	stopReason: string | null | undefined,
): string | null {
	switch (stopReason) {
		case "tool_use":
			return "tool_calls";
		case "max_tokens":
			return "length";
		case "end_turn":
		case "stop_sequence":
			return "stop";
		default:
			return stopReason ?? null;
	}
}

export function openAIFinishToAnthropicStop(
	finishReason: string | null | undefined,
): string | null {
	switch (finishReason) {
		case "tool_calls":
		case "function_call":
			return "tool_use";
		case "length":
			return "max_tokens";
		case "stop":
		case "content_filter":
			return "end_turn";
		default:
			return finishReason ?? null;
	}
}

export function toOpenAIUsage(
	usage: AnthropicUsage | null | undefined,
): OpenAIUsage {
	const inputTokens = usage?.input_tokens ?? 0;
	const cacheRead = usage?.cache_read_input_tokens ?? 0;
	const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
	const outputTokens = usage?.output_tokens ?? 0;
	return {
		prompt_tokens: inputTokens + cacheRead + cacheWrite,
		completion_tokens: outputTokens,
		total_tokens: inputTokens + cacheRead + cacheWrite + outputTokens,
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: cacheWrite,
	};
}

export function toAnthropicUsage(
	usage: OpenAIUsage | null | undefined,
): AnthropicUsage {
	const promptTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
	return {
		input_tokens: promptTokens,
		output_tokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
		cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
		cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
	};
}

export function normalizeOpenAIUsage(value: unknown): OpenAIUsage {
	if (!isRecord(value)) {
		return {};
	}

	const usage: OpenAIUsage = {};
	for (const key of [
		"prompt_tokens",
		"completion_tokens",
		"total_tokens",
		"input_tokens",
		"output_tokens",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
		"reasoning_tokens",
	] as const) {
		if (typeof value[key] === "number") {
			usage[key] = value[key];
		}
	}
	if (
		isRecord(value.prompt_tokens_details) &&
		typeof value.prompt_tokens_details.cached_tokens === "number"
	) {
		usage.cache_read_input_tokens = value.prompt_tokens_details.cached_tokens;
	}
	if (
		isRecord(value.input_tokens_details) &&
		typeof value.input_tokens_details.cached_tokens === "number"
	) {
		usage.cache_read_input_tokens = value.input_tokens_details.cached_tokens;
	}
	if (
		isRecord(value.output_tokens_details) &&
		typeof value.output_tokens_details.reasoning_tokens === "number"
	) {
		usage.reasoning_tokens = value.output_tokens_details.reasoning_tokens;
	}
	return usage;
}

export function generateId(prefix: string): string {
	return `${prefix}_${nodeCrypto.randomBytes(16).toString("hex")}`;
}

export function buildSseFrame(event: string | null, data: unknown): string {
	const payload = typeof data === "string" ? data : JSON.stringify(data);
	if (event) {
		return `event: ${event}\ndata: ${payload}\n\n`;
	}
	return `data: ${payload}\n\n`;
}

function createSseTransformState(): SseTransformState {
	return {
		buffer: "",
		decoder: new TextDecoder(),
		encoder: new TextEncoder(),
	};
}

function extractSseFrames(
	state: SseTransformState,
	chunk?: Uint8Array,
): SseFrame[] {
	if (chunk) {
		state.buffer += state.decoder.decode(chunk, { stream: true });
	} else {
		state.buffer += state.decoder.decode();
	}

	const frames: SseFrame[] = [];
	for (;;) {
		const lfIndex = state.buffer.indexOf("\n\n");
		const crlfIndex = state.buffer.indexOf("\r\n\r\n");
		let separatorIndex = -1;
		let separatorLength = 0;
		if (lfIndex >= 0 && (crlfIndex < 0 || lfIndex < crlfIndex)) {
			separatorIndex = lfIndex;
			separatorLength = 2;
		} else if (crlfIndex >= 0) {
			separatorIndex = crlfIndex;
			separatorLength = 4;
		}
		if (separatorIndex < 0) break;

		const block = state.buffer.slice(0, separatorIndex);
		state.buffer = state.buffer.slice(separatorIndex + separatorLength);

		let event: string | null = null;
		const dataLines: string[] = [];
		const lineDelimiter = separatorLength === 4 ? "\r\n" : "\n";
		for (const rawLine of block.split(lineDelimiter)) {
			const line = rawLine.trimEnd();
			if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		frames.push({
			event,
			data: dataLines.join("\n"),
		});
	}

	return frames;
}

export function isStreamingResponse(response: Response): boolean {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) return true;
	// Codex sometimes returns SSE with no content-type header
	if (response.body && !contentType) return true;
	return false;
}

export function createTransformedSseResponse(
	response: Response,
	transform: (frame: SseFrame) => string[],
): Response {
	const state = createSseTransformState();
	const upstream = response.body;
	if (!upstream) {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: sanitizeProxyHeaders(response.headers),
		});
	}

	const headers = sanitizeProxyHeaders(response.headers);
	headers.set("content-type", "text/event-stream; charset=utf-8");

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = upstream.getReader();
			try {
				for (;;) {
					const { value, done } = await reader.read();
					const frames = extractSseFrames(state, done ? undefined : value);
					const parts: string[] = [];
					for (const frame of frames) {
						for (const output of transform(frame)) {
							parts.push(output);
						}
					}
					if (parts.length > 0) {
						controller.enqueue(state.encoder.encode(parts.join("")));
					}
					if (done) {
						break;
					}
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			} finally {
				reader.releaseLock();
			}
		},
	});

	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function buildChatChunk(
	state: AnthropicToChatStreamState | ResponsesToChatStreamState,
	delta: JsonRecord,
	options?: { finishReason?: string | null; usage?: OpenAIUsage },
) {
	return {
		id: state.id,
		object: "chat.completion.chunk",
		created: state.created,
		model: state.model,
		choices: [
			{
				index: 0,
				delta,
				finish_reason: options?.finishReason ?? null,
			},
		],
		...(options?.usage ? { usage: options.usage } : {}),
	};
}

export function jsonResponse(
	body: JsonRecord,
	response: Response,
	contentType: string,
): Response {
	const headers = sanitizeProxyHeaders(response.headers);
	headers.set("content-type", contentType);
	return new Response(JSON.stringify(body), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
