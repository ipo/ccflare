import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../../types";
import { normalizeKimiToolSchema } from "../kimi-schema";
import {
	normalizeOpenAIResponsesConversation,
	renderConversationToOpenAIChatMessages,
} from "../request-conversation";
import { projectResponsesTools } from "../responses-tool-projection";

function reasoningText(item: JsonRecord): string | undefined {
	if (typeof item.reasoning_content === "string") return item.reasoning_content;
	if (typeof item.reasoning === "string") return item.reasoning;
	if (!Array.isArray(item.summary)) return undefined;
	const text = item.summary
		.flatMap((part) =>
			isRecord(part) && typeof part.text === "string" ? [part.text] : [],
		)
		.join("");
	return text || undefined;
}

function reasoningKey(input: JsonRecord): "reasoning" | "reasoning_content" {
	const serialized = JSON.stringify(input.input ?? []);
	return serialized.includes('"reasoning":') &&
		!serialized.includes('"reasoning_content":')
		? "reasoning"
		: "reasoning_content";
}

function applyPriorReasoning(
	input: JsonRecord,
	messages: JsonRecord[],
	thinking: JsonRecord | undefined,
): void {
	const prior = (Array.isArray(input.input) ? input.input : [])
		.flatMap((item) => (isRecord(item) ? [reasoningText(item)] : []))
		.filter((value): value is string => value !== undefined);
	const assistants = messages.filter((message) => message.role === "assistant");
	const key = reasoningKey(input);
	for (const [index, text] of prior.entries()) {
		const message = assistants[index] ?? assistants.at(-1);
		if (message) message[key] = text;
	}

	const reasoning = isRecord(input.reasoning) ? input.reasoning : undefined;
	if (reasoning?.keep === "all" && thinking?.type !== "disabled") {
		for (const message of assistants) {
			if (message[key] === undefined) message[key] = "";
		}
	}
}

function projectKimiTools(input: JsonRecord): {
	tools: JsonRecord[];
	toolChoice?: unknown;
} {
	const projection = projectResponsesTools(input);
	const tools = projection.tools.map((tool) => {
		const name = typeof tool.name === "string" ? tool.name : "tool";
		if (name.startsWith("$")) {
			return { type: "builtin_function", function: { name } };
		}
		return {
			type: "function",
			function: {
				name,
				description:
					typeof tool.description === "string" ? tool.description : "",
				parameters: normalizeKimiToolSchema(
					isRecord(tool.input_schema) ? tool.input_schema : {},
				),
			},
		};
	});

	let toolChoice: unknown;
	const choice = projection.toolChoice;
	if (choice?.type === "any") toolChoice = "required";
	if (choice?.type === "auto") toolChoice = "auto";
	if (choice?.type === "none") toolChoice = "none";
	if (choice?.type === "tool" && typeof choice.name === "string") {
		toolChoice = {
			type: choice.name.startsWith("$") ? "builtin_function" : "function",
			function: { name: choice.name },
		};
	}
	return { tools, toolChoice };
}

function applyStructuredOutput(input: JsonRecord, output: JsonRecord): void {
	const text = isRecord(input.text) ? input.text : null;
	const format = text && isRecord(text.format) ? text.format : null;
	if (!format || typeof format.type !== "string") return;
	if (format.type === "text") output.response_format = { type: "text" };
	if (format.type === "json_object") {
		output.response_format = { type: "json_object" };
	}
	if (format.type === "json_schema") {
		output.response_format = {
			type: "json_schema",
			json_schema: {
				name: typeof format.name === "string" ? format.name : "response",
				schema: isRecord(format.schema)
					? normalizeKimiToolSchema(format.schema)
					: {},
				strict: format.strict === true,
				...(typeof format.description === "string"
					? { description: format.description }
					: {}),
			},
		};
	}
}

function kimiThinking(
	input: JsonRecord,
	model: string,
): JsonRecord | undefined {
	if (
		!isRecord(input.reasoning) ||
		typeof input.reasoning.effort !== "string"
	) {
		return undefined;
	}
	const effort = input.reasoning.effort;
	if (effort === "none" || effort === "off") return { type: "disabled" };
	if (
		(model.startsWith("kimi-for-coding") || model.includes("code")) &&
		(effort === "minimal" || effort === "on")
	) {
		return { type: "enabled" };
	}
	return {
		type: "enabled",
		effort,
		...(input.reasoning.keep !== undefined
			? { keep: input.reasoning.keep }
			: {}),
	};
}

export function convertOpenAIResponsesRequestToKimiChat(
	input: JsonRecord,
	model: string,
): JsonRecord {
	const messages = renderConversationToOpenAIChatMessages(
		normalizeOpenAIResponsesConversation(input),
	);
	for (const message of messages) {
		if (
			message.role === "assistant" &&
			Array.isArray(message.tool_calls) &&
			message.content === ""
		) {
			delete message.content;
		}
	}
	const thinking = kimiThinking(input, model);
	applyPriorReasoning(input, messages, thinking);

	const output: JsonRecord = {
		model,
		messages,
		stream: input.stream === true,
	};
	if (input.stream === true) {
		output.stream_options = { include_usage: true };
	}
	if (typeof input.max_output_tokens === "number") {
		output.max_completion_tokens = input.max_output_tokens;
	}
	for (const field of [
		"temperature",
		"top_p",
		"parallel_tool_calls",
		"presence_penalty",
		"frequency_penalty",
		"stop",
		"prompt_cache_key",
	] as const) {
		if (input[field] !== undefined) output[field] = input[field];
	}
	if (thinking) output.thinking = thinking;

	const projected = projectKimiTools(input);
	if (projected.tools.length > 0) output.tools = projected.tools;
	if (projected.toolChoice !== undefined) {
		output.tool_choice = projected.toolChoice;
	}
	applyStructuredOutput(input, output);
	return output;
}
