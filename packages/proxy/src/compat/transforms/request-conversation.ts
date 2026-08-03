import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../types";
import {
	buildAnthropicTextBlock,
	convertAnthropicContentPartToOpenAI,
	convertAnthropicToolResultContentToOpenAI,
	convertOpenAIMessageContentToAnthropic,
	convertOpenAIMessageContentToResponses,
	convertOpenAIToolResultContentToAnthropic,
	convertResponsesMessageContentToOpenAI,
	extractAnthropicTextAndTools,
} from "./content-parts";
import { asArray, generateId, textContentFromUnknown } from "./shared";

type NormalizedToolCall = {
	id: string;
	name: string;
	arguments: string;
};

type NormalizedConversationMessage =
	| {
			role: "user" | "assistant";
			content: JsonRecord[];
			toolCalls?: NormalizedToolCall[];
			reasoning?: string;
			forceEmptyContent?: boolean;
	  }
	| {
			role: "tool";
			toolCallId: string;
			content: unknown;
	  };

type NormalizedConversation = {
	systemTexts: string[];
	messages: NormalizedConversationMessage[];
};

export function normalizeAnthropicConversation(
	input: JsonRecord,
): NormalizedConversation {
	const systemTexts: string[] = [];
	const systemText = textContentFromUnknown(input.system);
	if (systemText) {
		systemTexts.push(systemText);
	}

	const messages: NormalizedConversationMessage[] = [];
	for (const message of Array.isArray(input.messages) ? input.messages : []) {
		if (!isRecord(message) || typeof message.role !== "string") continue;
		const content = Array.isArray(message.content) ? message.content : [];
		if (message.role === "user") {
			const pendingContent: JsonRecord[] = [];
			for (const item of content) {
				if (!isRecord(item)) continue;
				if (item.type === "text" || item.type === "image") {
					const converted = convertAnthropicContentPartToOpenAI(item);
					if (converted) {
						pendingContent.push(converted);
					}
					continue;
				}
				if (item.type === "tool_result") {
					pushNormalizedUserMessage(messages, pendingContent);
					messages.push({
						role: "tool",
						toolCallId:
							typeof item.tool_use_id === "string"
								? item.tool_use_id
								: generateId("call"),
						content: convertAnthropicToolResultContentToOpenAI(item.content),
					});
				}
			}
			pushNormalizedUserMessage(messages, pendingContent);
			continue;
		}

		const extracted = extractAnthropicTextAndTools(content);
		const contentItems = content
			.map((item) => convertAnthropicContentPartToOpenAI(item))
			.filter((item): item is JsonRecord => item != null);
		messages.push({
			role: "assistant",
			content: contentItems,
			toolCalls: extracted.toolCalls.map((toolCall) => ({
				id: toolCall.id,
				name: toolCall.function.name,
				arguments: toolCall.function.arguments,
			})),
			reasoning: extracted.reasoning || undefined,
			forceEmptyContent:
				contentItems.length === 0 &&
				(extracted.reasoning.length > 0 || extracted.toolCalls.length > 0),
		});
	}

	return { systemTexts, messages };
}

export function normalizeOpenAIChatConversation(
	messagesInput: unknown,
): NormalizedConversation {
	const systemTexts: string[] = [];
	const messages: NormalizedConversationMessage[] = [];

	for (const message of Array.isArray(messagesInput) ? messagesInput : []) {
		if (!isRecord(message) || typeof message.role !== "string") continue;
		if (message.role === "system" || message.role === "developer") {
			const text = textContentFromUnknown(message.content);
			if (text) systemTexts.push(text);
			continue;
		}

		if (message.role === "tool") {
			messages.push({
				role: "tool",
				toolCallId:
					typeof message.tool_call_id === "string"
						? message.tool_call_id
						: generateId("toolu"),
				content: message.content,
			});
			continue;
		}

		const toolCalls = Array.isArray(message.tool_calls)
			? message.tool_calls
					.map((toolCall) => normalizeOpenAIToolCall(toolCall))
					.filter(
						(toolCall): toolCall is NormalizedToolCall => toolCall != null,
					)
			: undefined;
		const content = normalizeOpenAICompatibleContent(message.content);
		const role = message.role === "assistant" ? "assistant" : "user";
		messages.push({
			role,
			content,
			toolCalls,
			forceEmptyContent:
				role === "assistant" &&
				content.length === 0 &&
				(toolCalls?.length ?? 0) > 0,
		});
	}

	return { systemTexts, messages };
}

export function normalizeOpenAIResponsesConversation(
	input: JsonRecord,
): NormalizedConversation {
	const systemTexts: string[] = [];
	if (typeof input.instructions === "string" && input.instructions.trim()) {
		systemTexts.push(input.instructions);
	}

	const messages: NormalizedConversationMessage[] = [];
	const inputItems =
		typeof input.input === "string" ? [input.input] : asArray(input.input);
	for (const item of inputItems) {
		if (typeof item === "string") {
			messages.push({
				role: "user",
				content: [{ type: "text", text: item }],
			});
			continue;
		}
		if (!isRecord(item)) continue;

		const itemType =
			typeof item.type === "string"
				? item.type
				: typeof item.role === "string"
					? "message"
					: "";
		if (itemType === "function_call") {
			messages.push({
				role: "assistant",
				content: [],
				toolCalls: [
					{
						id:
							typeof item.call_id === "string" && item.call_id
								? item.call_id
								: generateId("call"),
						name: typeof item.name === "string" ? item.name : "tool",
						arguments:
							typeof item.arguments === "string"
								? item.arguments
								: JSON.stringify(item.arguments ?? {}),
					},
				],
				forceEmptyContent: true,
			});
			continue;
		}
		if (itemType === "function_call_output") {
			messages.push({
				role: "tool",
				toolCallId:
					typeof item.call_id === "string" ? item.call_id : generateId("call"),
				content:
					typeof item.output === "string"
						? item.output
						: JSON.stringify(item.output ?? ""),
			});
			continue;
		}

		const role =
			typeof item.role === "string"
				? item.role === "assistant"
					? "assistant"
					: item.role === "developer" || item.role === "system"
						? "system"
						: "user"
				: "user";
		if (role === "system") {
			const contentText = Array.isArray(item.content)
				? convertResponsesMessageContentToOpenAI(item.content)
				: typeof item.content === "string"
					? item.content
					: "";
			if (typeof contentText === "string" && contentText) {
				systemTexts.push(contentText);
			}
			continue;
		}

		const content = Array.isArray(item.content)
			? normalizeOpenAICompatibleContent(
					convertResponsesMessageContentToOpenAI(item.content),
				)
			: normalizeOpenAICompatibleContent(item.content);
		messages.push({
			role,
			content,
		});
	}

	return { systemTexts, messages };
}

export function renderConversationToOpenAIChatMessages(
	conversation: NormalizedConversation,
): JsonRecord[] {
	const messages: JsonRecord[] = conversation.systemTexts.map((text) => ({
		role: "system",
		content: text,
	}));

	for (const message of conversation.messages) {
		if (message.role === "tool") {
			messages.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				content: message.content,
			});
			continue;
		}

		const renderedContent = renderOpenAICompatibleContent(
			message.content,
			message.forceEmptyContent === true,
		);
		const output: JsonRecord = { role: message.role };
		if (renderedContent !== undefined) {
			output.content = renderedContent;
		}
		if (message.role === "assistant" && message.toolCalls?.length) {
			output.tool_calls = message.toolCalls.map((toolCall) => ({
				id: toolCall.id,
				type: "function",
				function: {
					name: toolCall.name,
					arguments: toolCall.arguments,
				},
			}));
		}
		if (message.role === "assistant" && message.reasoning) {
			output.reasoning_content = message.reasoning;
		}
		messages.push(output);
	}

	return messages;
}

export function renderConversationToResponsesInput(
	conversation: NormalizedConversation,
): { instructions?: string; input: JsonRecord[] } {
	const input: JsonRecord[] = [];
	for (const message of conversation.messages) {
		if (message.role === "tool") {
			input.push({
				type: "function_call_output",
				call_id: message.toolCallId,
				output: message.content,
			});
			continue;
		}

		const content = convertOpenAIMessageContentToResponses(
			message.content,
			message.role,
		);
		if (content.length > 0) {
			input.push({
				type: "message",
				role: message.role,
				content,
			});
		}
		if (message.role === "assistant" && message.toolCalls?.length) {
			for (const toolCall of message.toolCalls) {
				input.push({
					type: "function_call",
					call_id: toolCall.id,
					name: toolCall.name,
					arguments: toolCall.arguments,
				});
			}
		}
	}

	return {
		instructions: conversation.systemTexts.join("\n\n") || undefined,
		input,
	};
}

export function renderConversationToAnthropic(
	conversation: NormalizedConversation,
): { system?: JsonRecord[]; messages: JsonRecord[] } {
	const messages: JsonRecord[] = [];

	for (const message of conversation.messages) {
		if (message.role === "tool") {
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: message.toolCallId,
						content: convertOpenAIToolResultContentToAnthropic(message.content),
					},
				],
			});
			continue;
		}

		const content = convertOpenAIMessageContentToAnthropic(message.content);
		if (message.role === "assistant" && message.toolCalls?.length) {
			for (const toolCall of message.toolCalls) {
				content.push({
					type: "tool_use",
					id: toolCall.id,
					name: toolCall.name,
					input: parseToolArguments(toolCall.arguments),
				});
			}
		}
		messages.push({
			role: message.role,
			content: content.length > 0 ? content : [buildAnthropicTextBlock("")],
		});
	}

	const system =
		conversation.systemTexts.length > 0
			? conversation.systemTexts.map((text) => buildAnthropicTextBlock(text))
			: undefined;
	if (messages.length === 0 && system) {
		messages.push({
			role: "user",
			content: [buildAnthropicTextBlock("")],
		});
	}

	return { system, messages };
}

function pushNormalizedUserMessage(
	messages: NormalizedConversationMessage[],
	content: JsonRecord[],
): void {
	if (content.length === 0) {
		return;
	}
	messages.push({ role: "user", content: [...content] });
	content.length = 0;
}

function normalizeOpenAICompatibleContent(content: unknown): JsonRecord[] {
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) {
		return [];
	}

	const normalized: JsonRecord[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			normalized.push({ type: "text", text: item });
			continue;
		}
		if (!isRecord(item) || typeof item.type !== "string") {
			continue;
		}
		if (item.type === "text" && typeof item.text === "string") {
			normalized.push({ type: "text", text: item.text });
			continue;
		}
		if (
			item.type === "image_url" &&
			isRecord(item.image_url) &&
			typeof item.image_url.url === "string"
		) {
			normalized.push({
				type: "image_url",
				image_url: { url: item.image_url.url },
			});
			continue;
		}
		if (
			item.type === "file" &&
			isRecord(item.file) &&
			typeof item.file.file_data === "string"
		) {
			normalized.push({
				type: "file",
				file: {
					file_data: item.file.file_data,
					...(typeof item.file.filename === "string"
						? { filename: item.file.filename }
						: {}),
				},
			});
		}
	}

	return normalized;
}

function renderOpenAICompatibleContent(
	content: JsonRecord[],
	forceEmptyContent: boolean,
): string | JsonRecord[] | undefined {
	if (content.length === 0) {
		return forceEmptyContent ? "" : undefined;
	}
	if (
		content.length === 1 &&
		content[0].type === "text" &&
		typeof content[0].text === "string"
	) {
		return content[0].text;
	}
	return content;
}

function normalizeOpenAIToolCall(toolCall: unknown): NormalizedToolCall | null {
	if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
		return null;
	}
	return {
		id:
			typeof toolCall.id === "string" && toolCall.id
				? toolCall.id
				: generateId("call"),
		name:
			typeof toolCall.function.name === "string"
				? toolCall.function.name
				: "tool",
		arguments:
			typeof toolCall.function.arguments === "string"
				? toolCall.function.arguments
				: JSON.stringify(toolCall.function.arguments ?? {}),
	};
}

function parseToolArguments(argumentsText: string): unknown {
	try {
		return JSON.parse(argumentsText);
	} catch {
		return {};
	}
}
