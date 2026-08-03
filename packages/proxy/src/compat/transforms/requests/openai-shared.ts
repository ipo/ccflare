import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../../types";
import {
	normalizeOpenAIChatConversation,
	normalizeOpenAIResponsesConversation,
	renderConversationToAnthropic,
	renderConversationToOpenAIChatMessages,
	renderConversationToResponsesInput,
} from "../request-conversation";
import { applyOpenAIThinkingToAnthropic } from "../request-thinking";
import {
	applyOpenAIChatStructuredOutputs,
	mapOpenAIChatToolChoiceToResponses,
} from "./responses-format";

export { normalizeCodexResponsesRequest } from "./codex";

function mapOpenAIToolChoiceToAnthropic(
	toolChoice: unknown,
): JsonRecord | undefined {
	if (typeof toolChoice === "string") {
		if (toolChoice === "required") return { type: "any" };
		if (toolChoice === "auto") return { type: "auto" };
		return undefined;
	}
	if (!isRecord(toolChoice) || toolChoice.type !== "function") {
		return undefined;
	}
	// Responses format: { type: "function", name: "..." }
	if (typeof toolChoice.name === "string") {
		return { type: "tool", name: toolChoice.name };
	}
	// Chat format: { type: "function", function: { name: "..." } }
	if (
		isRecord(toolChoice.function) &&
		typeof toolChoice.function.name === "string"
	) {
		return { type: "tool", name: toolChoice.function.name };
	}
	return undefined;
}

export function convertOpenAIResponsesRequestToOpenAIChat(
	input: JsonRecord,
	model: string,
): JsonRecord {
	const output: JsonRecord = {
		model,
		messages: [],
		stream: input.stream === true,
	};

	if (typeof input.max_output_tokens === "number") {
		output.max_tokens = input.max_output_tokens;
	}
	if (typeof input.temperature === "number") {
		output.temperature = input.temperature;
	}
	if (typeof input.top_p === "number") {
		output.top_p = input.top_p;
	}
	if (typeof input.reasoning === "object" && isRecord(input.reasoning)) {
		if (typeof input.reasoning.effort === "string") {
			output.reasoning_effort = input.reasoning.effort;
		}
	}
	output.messages = renderConversationToOpenAIChatMessages(
		normalizeOpenAIResponsesConversation(input),
	);

	if (Array.isArray(input.tools)) {
		output.tools = input.tools
			.map((tool) => {
				if (!isRecord(tool)) return null;
				if (tool.type && tool.type !== "function") {
					return null;
				}
				return {
					type: "function",
					function: {
						name: typeof tool.name === "string" ? tool.name : "tool",
						description:
							typeof tool.description === "string" ? tool.description : "",
						parameters: isRecord(tool.parameters) ? tool.parameters : {},
					},
				};
			})
			.filter(Boolean);
	}

	if (input.tool_choice != null) {
		output.tool_choice = input.tool_choice;
	}

	return output;
}

export function convertOpenAIChatRequestToOpenAIResponses(
	input: JsonRecord,
	model: string,
): JsonRecord {
	const output: JsonRecord = {
		model,
		stream: input.stream === true,
		store: false,
		input: [],
	};

	if (typeof input.max_tokens === "number") {
		output.max_output_tokens = input.max_tokens;
	}
	if (typeof input.temperature === "number") {
		output.temperature = input.temperature;
	}
	if (typeof input.top_p === "number") {
		output.top_p = input.top_p;
	}
	if (typeof input.reasoning_effort === "string") {
		output.reasoning = { effort: input.reasoning_effort };
	}
	applyOpenAIChatStructuredOutputs(input, output);
	const rendered = renderConversationToResponsesInput(
		normalizeOpenAIChatConversation(input.messages),
	);
	output.input = rendered.input;
	output.instructions = rendered.instructions || "You are a helpful assistant.";

	if (Array.isArray(input.tools)) {
		output.tools = input.tools
			.map((tool) => {
				if (!isRecord(tool)) return null;
				if (tool.type && tool.type !== "function") {
					return tool;
				}
				if (!isRecord(tool.function)) return null;
				return {
					type: "function",
					name:
						typeof tool.function.name === "string"
							? tool.function.name
							: "tool",
					description:
						typeof tool.function.description === "string"
							? tool.function.description
							: "",
					parameters: isRecord(tool.function.parameters)
						? tool.function.parameters
						: {},
				};
			})
			.filter(Boolean);
	}

	if (input.tool_choice != null) {
		output.tool_choice = mapOpenAIChatToolChoiceToResponses(input.tool_choice);
	}

	return output;
}

export function convertOpenAIChatRequestToAnthropic(
	input: JsonRecord,
	model: string,
): JsonRecord {
	const output: JsonRecord = {
		model,
		max_tokens:
			(typeof input.max_tokens === "number" && input.max_tokens) ||
			(typeof input.max_completion_tokens === "number" &&
				input.max_completion_tokens) ||
			4096,
		messages: [],
		stream: input.stream === true,
	};

	if (typeof input.temperature === "number") {
		output.temperature = input.temperature;
	}
	if (typeof input.top_p === "number") {
		output.top_p = input.top_p;
	}
	if (typeof input.stop === "string") {
		output.stop_sequences = [input.stop];
	} else if (Array.isArray(input.stop)) {
		output.stop_sequences = input.stop.filter(
			(item): item is string => typeof item === "string",
		);
	}
	if (typeof input.reasoning_effort === "string") {
		applyOpenAIThinkingToAnthropic(output, input.reasoning_effort);
	}
	const rendered = renderConversationToAnthropic(
		normalizeOpenAIChatConversation(input.messages),
	);
	output.messages = rendered.messages;
	if (rendered.system) {
		output.system = rendered.system;
	}

	if (Array.isArray(input.tools)) {
		output.tools = input.tools
			.map((tool) => {
				if (!isRecord(tool) || !isRecord(tool.function)) return null;
				return {
					name:
						typeof tool.function.name === "string"
							? tool.function.name
							: "tool",
					description:
						typeof tool.function.description === "string"
							? tool.function.description
							: "",
					input_schema: isRecord(tool.function.parameters)
						? tool.function.parameters
						: {},
				};
			})
			.filter(Boolean);
	}

	if (input.tool_choice != null) {
		const mapped = mapOpenAIToolChoiceToAnthropic(input.tool_choice);
		if (mapped) {
			output.tool_choice = mapped;
		}
	}

	return output;
}

export function convertOpenAIResponsesRequestToAnthropic(
	input: JsonRecord,
	model: string,
): JsonRecord {
	const output: JsonRecord = {
		model,
		max_tokens:
			(typeof input.max_output_tokens === "number" &&
				input.max_output_tokens) ||
			4096,
		messages: [],
		stream: input.stream === true,
	};

	if (typeof input.temperature === "number") {
		output.temperature = input.temperature;
	}
	if (typeof input.top_p === "number") {
		output.top_p = input.top_p;
	}
	if (isRecord(input.reasoning) && typeof input.reasoning.effort === "string") {
		applyOpenAIThinkingToAnthropic(output, input.reasoning.effort);
	}

	const rendered = renderConversationToAnthropic(
		normalizeOpenAIResponsesConversation(input),
	);
	output.messages = rendered.messages;
	if (rendered.system) {
		output.system = rendered.system;
	}

	if (Array.isArray(input.tools)) {
		output.tools = input.tools
			.map((tool) => {
				if (!isRecord(tool)) return null;
				if (tool.type && tool.type !== "function") {
					return null;
				}
				return {
					name: typeof tool.name === "string" ? tool.name : "tool",
					description:
						typeof tool.description === "string" ? tool.description : "",
					input_schema: isRecord(tool.parameters) ? tool.parameters : {},
				};
			})
			.filter(Boolean);
	}

	if (input.tool_choice != null) {
		const mapped = mapOpenAIToolChoiceToAnthropic(input.tool_choice);
		if (mapped) {
			output.tool_choice = mapped;
		}
	}

	return output;
}
