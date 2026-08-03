import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../types";
import {
	buildAnthropicTextBlock,
	extractAnthropicTextAndTools,
} from "./content-parts";
import { generateId, maybeParseJson } from "./shared";

export function convertAnthropicJsonToOpenAIChatMessage(
	body: JsonRecord,
): JsonRecord {
	const extracted = extractAnthropicTextAndTools(body.content);
	return {
		role: "assistant",
		content: extracted.text || null,
		...(extracted.toolCalls.length > 0
			? { tool_calls: extracted.toolCalls }
			: {}),
		...(extracted.reasoning ? { reasoning_content: extracted.reasoning } : {}),
	};
}

export function convertAnthropicContentToOpenAIResponsesOutput(
	content: unknown,
): JsonRecord[] {
	const output: JsonRecord[] = [];
	for (const block of Array.isArray(content) ? content : []) {
		if (!isRecord(block)) continue;
		if (block.type === "text") {
			output.push({
				id: generateId("msg"),
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: block.text ?? "" }],
			});
		}
		if (block.type === "tool_use") {
			output.push({
				id: generateId("fc"),
				type: "function_call",
				status: "completed",
				call_id: typeof block.id === "string" ? block.id : generateId("call"),
				name: typeof block.name === "string" ? block.name : "tool",
				arguments: JSON.stringify(block.input ?? {}),
			});
		}
		if (block.type === "thinking") {
			output.push({
				id: generateId("rs"),
				type: "reasoning",
				status: "completed",
				summary: [
					{
						type: "summary_text",
						text: typeof block.thinking === "string" ? block.thinking : "",
					},
				],
			});
		}
	}
	return output;
}

export function formatAnthropicCompatNotice(
	payload: JsonRecord,
): string | null {
	if (
		payload.type === "system" &&
		typeof payload.subtype === "string" &&
		payload.subtype === "session_state_changed"
	) {
		const state = typeof payload.state === "string" ? payload.state : "unknown";
		return `Session state changed: ${state}`;
	}

	if (payload.type === "tool_progress") {
		const toolName =
			typeof payload.tool_name === "string" ? payload.tool_name : "tool";
		const elapsed =
			typeof payload.elapsed_time_seconds === "number"
				? `${payload.elapsed_time_seconds}s`
				: "in progress";
		return `Tool progress: ${toolName} (${elapsed})`;
	}

	if (payload.type === "tool_use_summary") {
		const summary =
			typeof payload.summary === "string" ? payload.summary.trim() : "";
		return summary ? `Tool summary: ${summary}` : null;
	}

	if (
		payload.type === "control_request" &&
		isRecord(payload.request) &&
		payload.request.subtype === "can_use_tool"
	) {
		const toolName =
			typeof payload.request.tool_name === "string"
				? payload.request.tool_name
				: "tool";
		return `Tool permission requested: ${toolName}`;
	}

	return null;
}

export function convertOpenAIResponsesOutputToAnthropic(output: unknown): {
	content: JsonRecord[];
	hasToolCalls: boolean;
} {
	const content: JsonRecord[] = [];
	let hasToolCalls = false;

	for (const item of Array.isArray(output) ? output : []) {
		if (!isRecord(item)) continue;
		if (item.type === "message" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (isRecord(part) && typeof part.text === "string") {
					content.push(buildAnthropicTextBlock(part.text));
				}
			}
		}
		if (item.type === "function_call") {
			hasToolCalls = true;
			content.push({
				type: "tool_use",
				id:
					typeof item.call_id === "string" ? item.call_id : generateId("toolu"),
				name: typeof item.name === "string" ? item.name : "tool",
				input:
					typeof item.arguments === "string"
						? (maybeParseJson(item.arguments) ?? {})
						: (item.arguments ?? {}),
			});
		}
		if (item.type === "reasoning" && Array.isArray(item.summary)) {
			const text = item.summary
				.map((part) =>
					isRecord(part) && typeof part.text === "string" ? part.text : "",
				)
				.filter(Boolean)
				.join("\n\n");
			if (text) {
				content.push({
					type: "thinking",
					thinking: text,
				});
			}
		}
	}

	return { content, hasToolCalls };
}

export function convertOpenAIResponsesOutputToChatMessage(output: unknown): {
	message: JsonRecord;
	finishReason: string;
} {
	const message: JsonRecord = { role: "assistant", content: "" };
	const textParts: string[] = [];
	const toolCalls: JsonRecord[] = [];

	for (const item of Array.isArray(output) ? output : []) {
		if (!isRecord(item)) continue;
		if (item.type === "message" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (isRecord(part) && typeof part.text === "string") {
					textParts.push(part.text);
				}
			}
		}
		if (item.type === "function_call") {
			toolCalls.push({
				id:
					typeof item.call_id === "string" ? item.call_id : generateId("call"),
				type: "function",
				function: {
					name: typeof item.name === "string" ? item.name : "tool",
					arguments:
						typeof item.arguments === "string"
							? item.arguments
							: JSON.stringify(item.arguments ?? {}),
				},
			});
		}
	}

	message.content = textParts.join("") || null;
	if (toolCalls.length > 0) {
		message.tool_calls = toolCalls;
	}

	return {
		message,
		finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
	};
}
