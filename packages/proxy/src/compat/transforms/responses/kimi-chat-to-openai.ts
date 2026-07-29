import { isRecord } from "@ccflare/types";
import type { JsonRecord, OpenAIUsage, SseFrame } from "../../types";
import { applyOpenAIResponsesRequestFields } from "../request-context";
import {
	projectResponsesTools,
	type ResponsesToolIdentity,
	reverseResponsesToolCall,
} from "../responses-tool-projection";
import {
	buildSseFrame,
	createTransformedSseResponse,
	generateId,
	isStreamingResponse,
	jsonResponse,
} from "../shared";

const MAX_SSE_FRAME_CHARS = 8 * 1024 * 1024;
const MAX_BUFFERED_CHARS = 16 * 1024 * 1024;
const MAX_FRAGMENT_CHARS = 2 * 1024 * 1024;
const MAX_FRAGMENTS = 4096;
const MAX_TOOL_CALLS = 128;
const MAX_ID_OR_NAME_CHARS = 1024;

type TextItem = {
	kind: "reasoning" | "message";
	choiceIndex: number;
	outputIndex: number;
	id: string;
	text: string;
};

type ToolItem = {
	choiceIndex: number;
	toolIndex: number;
	rawId: string;
	wireName: string;
	argumentsText: string;
	argumentFragments: string[];
};

type KimiStreamState = {
	sequence: number;
	responseId: string;
	model: string;
	createdAt: number;
	started: boolean;
	ended: boolean;
	finishReason: string | null;
	usage: OpenAIUsage;
	nextOutputIndex: number;
	reasoningItems: Map<number, TextItem>;
	messageItems: Map<number, TextItem>;
	toolItems: Map<string, ToolItem>;
	bufferedChars: number;
	fragmentCount: number;
};

function usageFromChat(usage: JsonRecord | undefined): OpenAIUsage {
	if (!usage) return {};
	const inputTokens =
		typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
	const outputTokens =
		typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
	const promptDetails = isRecord(usage.prompt_tokens_details)
		? usage.prompt_tokens_details
		: undefined;
	const completionDetails = isRecord(usage.completion_tokens_details)
		? usage.completion_tokens_details
		: undefined;
	const cachedTokens =
		typeof promptDetails?.cached_tokens === "number"
			? promptDetails.cached_tokens
			: typeof usage.cached_tokens === "number"
				? usage.cached_tokens
				: undefined;
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens:
			typeof usage.total_tokens === "number"
				? usage.total_tokens
				: inputTokens + outputTokens,
		...(cachedTokens !== undefined
			? { input_tokens_details: { cached_tokens: cachedTokens } }
			: {}),
		...(typeof completionDetails?.reasoning_tokens === "number"
			? {
					output_tokens_details: {
						reasoning_tokens: completionDetails.reasoning_tokens,
					},
				}
			: {}),
	} as OpenAIUsage;
}

function baseResponse(
	state: KimiStreamState,
	originalRequest: JsonRecord,
	fields: JsonRecord,
): JsonRecord {
	return applyOpenAIResponsesRequestFields(
		{
			id: state.responseId,
			object: "response",
			created_at: state.createdAt,
			model: state.model,
			...fields,
		},
		originalRequest,
	);
}

function failedResponse(
	originalRequest: JsonRecord,
	message = "Kimi returned malformed Chat Completions JSON",
	state?: KimiStreamState,
): JsonRecord {
	const model =
		typeof originalRequest.model === "string"
			? originalRequest.model.replace(/^kimi\//, "")
			: "unknown";
	return applyOpenAIResponsesRequestFields(
		{
			id: state?.responseId ?? generateId("resp"),
			object: "response",
			created_at: state?.createdAt ?? Math.floor(Date.now() / 1000),
			model: state?.model || model,
			status: "failed",
			error: { code: "invalid_upstream_response", message },
			output: state ? buildPartialOutput(state) : [],
			usage: state?.usage ?? {},
		},
		originalRequest,
	);
}

function convertChatBody(
	body: JsonRecord,
	originalRequest: JsonRecord,
): JsonRecord {
	const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
	const message =
		isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
	if (!message) return failedResponse(originalRequest);

	const output: JsonRecord[] = [];
	const reasoning =
		typeof message.reasoning_content === "string"
			? message.reasoning_content
			: typeof message.reasoning === "string"
				? message.reasoning
				: typeof message.reasoning_details === "string"
					? message.reasoning_details
					: undefined;
	if (reasoning !== undefined) {
		output.push({
			id: generateId("rs"),
			type: "reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: reasoning }],
		});
	}
	if (typeof message.content === "string" && message.content.length > 0) {
		output.push({
			id: generateId("msg"),
			type: "message",
			status: "completed",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: message.content,
					annotations: [],
				},
			],
		});
	}

	const reverse = projectResponsesTools(originalRequest).reverseByWireName;
	for (const toolCall of Array.isArray(message.tool_calls)
		? message.tool_calls
		: []) {
		if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
		const callId =
			typeof toolCall.id === "string" ? toolCall.id : generateId("call");
		const wireName =
			typeof toolCall.function.name === "string"
				? toolCall.function.name
				: "tool";
		const argumentsText =
			typeof toolCall.function.arguments === "string"
				? toolCall.function.arguments
				: JSON.stringify(toolCall.function.arguments ?? {});
		let parsed: unknown = {};
		try {
			parsed = JSON.parse(argumentsText);
		} catch {
			parsed = {};
		}
		const reversed = reverseResponsesToolCall(wireName, parsed, reverse);
		output.push({
			id: `${reversed.type === "custom_tool_call" ? "ctc" : "fc"}_${callId}`,
			status: "completed",
			call_id: callId,
			...reversed,
			...(reversed.type === "function_call"
				? { arguments: argumentsText }
				: {}),
		});
	}

	const finishReason =
		isRecord(choice) && typeof choice.finish_reason === "string"
			? choice.finish_reason
			: null;
	return applyOpenAIResponsesRequestFields(
		{
			id: typeof body.id === "string" ? body.id : generateId("resp"),
			object: "response",
			created_at:
				typeof body.created === "number"
					? body.created
					: Math.floor(Date.now() / 1000),
			model: typeof body.model === "string" ? body.model : "unknown",
			status: finishReason === "length" ? "incomplete" : "completed",
			...(finishReason === "length"
				? { incomplete_details: { reason: "max_output_tokens" } }
				: {}),
			output,
			usage: usageFromChat(isRecord(body.usage) ? body.usage : undefined),
		},
		originalRequest,
	);
}

function nextSequence(state: KimiStreamState): number {
	const sequence = state.sequence;
	state.sequence += 1;
	return sequence;
}

function ensureStarted(
	state: KimiStreamState,
	originalRequest: JsonRecord,
): string[] {
	if (state.started) return [];
	state.started = true;
	return [
		buildSseFrame("response.created", {
			type: "response.created",
			sequence_number: nextSequence(state),
			response: baseResponse(state, originalRequest, {
				status: "in_progress",
				output: [],
			}),
		}),
		buildSseFrame("response.in_progress", {
			type: "response.in_progress",
			sequence_number: nextSequence(state),
			response: baseResponse(state, originalRequest, {
				status: "in_progress",
			}),
		}),
	];
}

function reserveFragment(state: KimiStreamState, value: string): void {
	if (value.length > MAX_FRAGMENT_CHARS) {
		throw new Error(
			`Kimi stream fragment exceeded ${MAX_FRAGMENT_CHARS} characters`,
		);
	}
	state.fragmentCount += 1;
	state.bufferedChars += value.length;
	if (state.fragmentCount > MAX_FRAGMENTS) {
		throw new Error(`Kimi stream exceeded ${MAX_FRAGMENTS} fragments`);
	}
	if (state.bufferedChars > MAX_BUFFERED_CHARS) {
		throw new Error(
			`Kimi stream exceeded ${MAX_BUFFERED_CHARS} buffered characters`,
		);
	}
}

function appendBounded(
	state: KimiStreamState,
	current: string,
	fragment: string,
	label: string,
	maxChars = MAX_BUFFERED_CHARS,
): string {
	reserveFragment(state, fragment);
	if (current.length + fragment.length > maxChars) {
		throw new Error(`Kimi ${label} exceeded ${maxChars} characters`);
	}
	return current + fragment;
}

function addTextDelta(
	state: KimiStreamState,
	originalRequest: JsonRecord,
	choiceIndex: number,
	kind: "reasoning" | "message",
	delta: string,
): string[] {
	const items =
		kind === "reasoning" ? state.reasoningItems : state.messageItems;
	let item = items.get(choiceIndex);
	const outputs: string[] = [];
	if (!item) {
		const outputIndex = state.nextOutputIndex;
		state.nextOutputIndex += 1;
		item = {
			kind,
			choiceIndex,
			outputIndex,
			id: generateId(kind === "reasoning" ? "rs" : "msg"),
			text: "",
		};
		items.set(choiceIndex, item);
		outputs.push(...ensureStarted(state, originalRequest));
		outputs.push(
			buildSseFrame("response.output_item.added", {
				type: "response.output_item.added",
				sequence_number: nextSequence(state),
				output_index: outputIndex,
				item:
					kind === "reasoning"
						? {
								id: item.id,
								type: "reasoning",
								status: "in_progress",
								summary: [],
							}
						: {
								id: item.id,
								type: "message",
								status: "in_progress",
								role: "assistant",
								content: [],
							},
			}),
		);
		if (kind === "message") {
			outputs.push(
				buildSseFrame("response.content_part.added", {
					type: "response.content_part.added",
					sequence_number: nextSequence(state),
					output_index: outputIndex,
					item_id: item.id,
					content_index: 0,
					part: {
						type: "output_text",
						text: "",
						annotations: [],
						logprobs: [],
					},
				}),
			);
		}
	}

	item.text = appendBounded(state, item.text, delta, `${kind} output`);
	if (delta.length > 0) {
		outputs.push(
			buildSseFrame(
				kind === "reasoning"
					? "response.reasoning_summary_text.delta"
					: "response.output_text.delta",
				kind === "reasoning"
					? {
							type: "response.reasoning_summary_text.delta",
							sequence_number: nextSequence(state),
							output_index: item.outputIndex,
							item_id: item.id,
							summary_index: 0,
							delta,
						}
					: {
							type: "response.output_text.delta",
							sequence_number: nextSequence(state),
							output_index: item.outputIndex,
							item_id: item.id,
							content_index: 0,
							delta,
						},
			),
		);
	}
	return outputs;
}

function toolKey(choiceIndex: number, toolIndex: number): string {
	return `${choiceIndex}:${toolIndex}`;
}

function addToolDelta(
	state: KimiStreamState,
	choiceIndex: number,
	value: JsonRecord,
): void {
	if (!Number.isInteger(value.index) || (value.index as number) < 0) {
		throw new Error(
			"Kimi tool-call delta requires a non-negative integer index",
		);
	}
	if (value.id !== undefined && typeof value.id !== "string") {
		throw new Error("Kimi tool-call id fragment must be a string");
	}
	if (value.function !== undefined && !isRecord(value.function)) {
		throw new Error("Kimi tool-call function delta must be an object");
	}
	if (
		isRecord(value.function) &&
		value.function.name !== undefined &&
		typeof value.function.name !== "string"
	) {
		throw new Error("Kimi tool-call name fragment must be a string");
	}
	if (
		isRecord(value.function) &&
		value.function.arguments !== undefined &&
		typeof value.function.arguments !== "string"
	) {
		throw new Error("Kimi tool-call arguments fragment must be a string");
	}
	const toolIndex = value.index as number;
	const key = toolKey(choiceIndex, toolIndex);
	let item = state.toolItems.get(key);
	if (!item) {
		if (state.toolItems.size >= MAX_TOOL_CALLS) {
			throw new Error(`Kimi stream exceeded ${MAX_TOOL_CALLS} tool calls`);
		}
		item = {
			choiceIndex,
			toolIndex,
			rawId: "",
			wireName: "",
			argumentsText: "",
			argumentFragments: [],
		};
		state.toolItems.set(key, item);
	}
	if (typeof value.id === "string") {
		item.rawId = appendBounded(
			state,
			item.rawId,
			value.id,
			"tool-call id",
			MAX_ID_OR_NAME_CHARS,
		);
	}
	if (isRecord(value.function)) {
		if (typeof value.function.name === "string") {
			item.wireName = appendBounded(
				state,
				item.wireName,
				value.function.name,
				"tool-call name",
				MAX_ID_OR_NAME_CHARS,
			);
		}
		if (typeof value.function.arguments === "string") {
			item.argumentsText = appendBounded(
				state,
				item.argumentsText,
				value.function.arguments,
				"tool-call arguments",
			);
			item.argumentFragments.push(value.function.arguments);
		}
	}
}

function updateMetadata(state: KimiStreamState, payload: JsonRecord): void {
	if (typeof payload.id === "string" && payload.id)
		state.responseId = payload.id;
	if (typeof payload.model === "string" && payload.model) {
		state.model = payload.model;
	}
	if (typeof payload.created === "number") state.createdAt = payload.created;
}

function updateUsage(state: KimiStreamState, value: unknown): void {
	if (isRecord(value)) state.usage = usageFromChat(value);
}

function textItemOutput(item: TextItem, status: "completed" | "incomplete") {
	if (item.kind === "reasoning") {
		return {
			id: item.id,
			type: "reasoning",
			status,
			summary: [{ type: "summary_text", text: item.text }],
		};
	}
	return {
		id: item.id,
		type: "message",
		status,
		role: "assistant",
		content: [
			{
				type: "output_text",
				text: item.text,
				annotations: [],
				logprobs: [],
			},
		],
	};
}

function sortedTextItems(state: KimiStreamState): TextItem[] {
	return [
		...state.reasoningItems.values(),
		...state.messageItems.values(),
	].sort((a, b) => a.outputIndex - b.outputIndex);
}

function buildPartialOutput(state: KimiStreamState): JsonRecord[] {
	return sortedTextItems(state).map((item) =>
		textItemOutput(item, "incomplete"),
	);
}

function finishTextItem(state: KimiStreamState, item: TextItem): string[] {
	if (item.kind === "reasoning") {
		return [
			buildSseFrame("response.reasoning_summary_text.done", {
				type: "response.reasoning_summary_text.done",
				sequence_number: nextSequence(state),
				output_index: item.outputIndex,
				item_id: item.id,
				summary_index: 0,
				text: item.text,
			}),
			buildSseFrame("response.output_item.done", {
				type: "response.output_item.done",
				sequence_number: nextSequence(state),
				output_index: item.outputIndex,
				item: textItemOutput(item, "completed"),
			}),
		];
	}
	return [
		buildSseFrame("response.output_text.done", {
			type: "response.output_text.done",
			sequence_number: nextSequence(state),
			output_index: item.outputIndex,
			item_id: item.id,
			content_index: 0,
			text: item.text,
		}),
		buildSseFrame("response.content_part.done", {
			type: "response.content_part.done",
			sequence_number: nextSequence(state),
			output_index: item.outputIndex,
			item_id: item.id,
			content_index: 0,
			part: {
				type: "output_text",
				text: item.text,
				annotations: [],
				logprobs: [],
			},
		}),
		buildSseFrame("response.output_item.done", {
			type: "response.output_item.done",
			sequence_number: nextSequence(state),
			output_index: item.outputIndex,
			item: textItemOutput(item, "completed"),
		}),
	];
}

function resolveTool(
	tool: ToolItem,
	reverseByWireName: ReadonlyMap<string, ResponsesToolIdentity>,
): { callId: string; reversed: JsonRecord } {
	if (!tool.wireName) throw new Error("Kimi tool call ended without a name");
	const callId = tool.rawId || generateId("call");
	const identity = reverseByWireName.get(tool.wireName);
	if (identity?.kind === "custom") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(tool.argumentsText || "{}");
		} catch {
			throw new Error(
				`Kimi custom tool '${tool.wireName}' returned invalid JSON arguments`,
			);
		}
		return {
			callId,
			reversed: reverseResponsesToolCall(
				tool.wireName,
				parsed,
				reverseByWireName,
			),
		};
	}
	return {
		callId,
		reversed: {
			...reverseResponsesToolCall(tool.wireName, {}, reverseByWireName),
			arguments: tool.argumentsText,
		},
	};
}

function finishToolItem(
	state: KimiStreamState,
	tool: ToolItem,
	reverseByWireName: ReadonlyMap<string, ResponsesToolIdentity>,
): { events: string[]; output: JsonRecord } {
	const outputIndex = state.nextOutputIndex;
	state.nextOutputIndex += 1;
	const { callId, reversed } = resolveTool(tool, reverseByWireName);
	const custom = reversed.type === "custom_tool_call";
	const itemId = `${custom ? "ctc" : "fc"}_${callId}`;
	const baseItem = {
		id: itemId,
		type: reversed.type,
		status: "in_progress",
		call_id: callId,
		name: reversed.name,
		...(typeof reversed.namespace === "string"
			? { namespace: reversed.namespace }
			: {}),
	};
	const events = [
		buildSseFrame("response.output_item.added", {
			type: "response.output_item.added",
			sequence_number: nextSequence(state),
			output_index: outputIndex,
			item: {
				...baseItem,
				...(custom ? { input: "" } : { arguments: "" }),
			},
		}),
	];
	if (custom) {
		const input = typeof reversed.input === "string" ? reversed.input : "";
		if (input) {
			events.push(
				buildSseFrame("response.custom_tool_call_input.delta", {
					type: "response.custom_tool_call_input.delta",
					sequence_number: nextSequence(state),
					output_index: outputIndex,
					item_id: itemId,
					call_id: callId,
					delta: input,
				}),
			);
		}
		const output = { ...baseItem, status: "completed", input };
		events.push(
			buildSseFrame("response.output_item.done", {
				type: "response.output_item.done",
				sequence_number: nextSequence(state),
				output_index: outputIndex,
				item: output,
			}),
		);
		return { events, output };
	}
	for (const delta of tool.argumentFragments) {
		if (!delta) continue;
		events.push(
			buildSseFrame("response.function_call_arguments.delta", {
				type: "response.function_call_arguments.delta",
				sequence_number: nextSequence(state),
				output_index: outputIndex,
				item_id: itemId,
				delta,
			}),
		);
	}
	events.push(
		buildSseFrame("response.function_call_arguments.done", {
			type: "response.function_call_arguments.done",
			sequence_number: nextSequence(state),
			output_index: outputIndex,
			item_id: itemId,
			arguments: tool.argumentsText,
		}),
	);
	const output = {
		...baseItem,
		status: "completed",
		arguments: tool.argumentsText,
	};
	events.push(
		buildSseFrame("response.output_item.done", {
			type: "response.output_item.done",
			sequence_number: nextSequence(state),
			output_index: outputIndex,
			item: output,
		}),
	);
	return { events, output };
}

function failStream(
	state: KimiStreamState,
	originalRequest: JsonRecord,
	message: string,
): string[] {
	if (state.ended) return [];
	state.ended = true;
	const outputs = ensureStarted(state, originalRequest);
	outputs.push(
		buildSseFrame("response.failed", {
			type: "response.failed",
			sequence_number: nextSequence(state),
			response: failedResponse(originalRequest, message, state),
		}),
	);
	return outputs;
}

function completeStream(
	state: KimiStreamState,
	originalRequest: JsonRecord,
	reverseByWireName: ReadonlyMap<string, ResponsesToolIdentity>,
): string[] {
	if (state.ended) return [];
	if (!state.finishReason) {
		return failStream(
			state,
			originalRequest,
			"Kimi stream ended without a valid finish_reason",
		);
	}
	const outputs = ensureStarted(state, originalRequest);
	const responseOutput: JsonRecord[] = [];
	for (const item of sortedTextItems(state)) {
		outputs.push(...finishTextItem(state, item));
		responseOutput.push(textItemOutput(item, "completed"));
	}
	const tools = [...state.toolItems.values()].sort(
		(a, b) => a.choiceIndex - b.choiceIndex || a.toolIndex - b.toolIndex,
	);
	try {
		for (const tool of tools) {
			const finished = finishToolItem(state, tool, reverseByWireName);
			outputs.push(...finished.events);
			responseOutput.push(finished.output);
		}
	} catch (error) {
		return failStream(
			state,
			originalRequest,
			error instanceof Error ? error.message : String(error),
		);
	}
	state.ended = true;
	const incomplete =
		state.finishReason === "length" || state.finishReason === "content_filter";
	const event = incomplete ? "response.incomplete" : "response.completed";
	outputs.push(
		buildSseFrame(event, {
			type: event,
			sequence_number: nextSequence(state),
			response: baseResponse(state, originalRequest, {
				status: incomplete ? "incomplete" : "completed",
				...(incomplete
					? {
							incomplete_details: {
								reason:
									state.finishReason === "content_filter"
										? "content_filter"
										: "max_output_tokens",
							},
						}
					: {}),
				output: responseOutput,
				usage: state.usage,
			}),
		}),
	);
	return outputs;
}

function transformKimiFrame(
	frame: SseFrame,
	state: KimiStreamState,
	originalRequest: JsonRecord,
	reverseByWireName: ReadonlyMap<string, ResponsesToolIdentity>,
): string[] {
	if (state.ended) return [];
	if (frame.data.trim() === "[DONE]") {
		return completeStream(state, originalRequest, reverseByWireName);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(frame.data);
	} catch {
		return failStream(
			state,
			originalRequest,
			"Kimi stream contained malformed JSON",
		);
	}
	if (!isRecord(parsed)) {
		return failStream(
			state,
			originalRequest,
			"Kimi stream frame must contain a JSON object",
		);
	}
	updateMetadata(state, parsed);
	const outputs = ensureStarted(state, originalRequest);
	try {
		updateUsage(state, parsed.usage);
		if (!Array.isArray(parsed.choices)) {
			return outputs;
		}
		for (const [position, rawChoice] of parsed.choices.entries()) {
			if (!isRecord(rawChoice)) {
				throw new Error(`Kimi choice at index ${position} must be an object`);
			}
			const choiceIndex =
				typeof rawChoice.index === "number" && Number.isInteger(rawChoice.index)
					? rawChoice.index
					: position;
			if (choiceIndex < 0) {
				throw new Error("Kimi choice index must be non-negative");
			}
			updateUsage(state, rawChoice.usage);
			if (rawChoice.delta !== undefined && !isRecord(rawChoice.delta)) {
				throw new Error("Kimi choice delta must be an object");
			}
			if (isRecord(rawChoice.delta)) {
				const reasoning =
					typeof rawChoice.delta.reasoning_content === "string"
						? rawChoice.delta.reasoning_content
						: typeof rawChoice.delta.reasoning === "string"
							? rawChoice.delta.reasoning
							: undefined;
				if (reasoning !== undefined) {
					outputs.push(
						...addTextDelta(
							state,
							originalRequest,
							choiceIndex,
							"reasoning",
							reasoning,
						),
					);
				}
				if (typeof rawChoice.delta.content === "string") {
					outputs.push(
						...addTextDelta(
							state,
							originalRequest,
							choiceIndex,
							"message",
							rawChoice.delta.content,
						),
					);
				}
				if (rawChoice.delta.tool_calls !== undefined) {
					if (!Array.isArray(rawChoice.delta.tool_calls)) {
						throw new Error("Kimi tool_calls delta must be an array");
					}
					for (const rawTool of rawChoice.delta.tool_calls) {
						if (!isRecord(rawTool)) {
							throw new Error("Kimi tool-call delta must be an object");
						}
						addToolDelta(state, choiceIndex, rawTool);
					}
				}
			}
			if (typeof rawChoice.finish_reason === "string") {
				if (choiceIndex !== 0) continue;
				if (
					rawChoice.finish_reason !== "stop" &&
					rawChoice.finish_reason !== "tool_calls" &&
					rawChoice.finish_reason !== "function_call" &&
					rawChoice.finish_reason !== "length" &&
					rawChoice.finish_reason !== "content_filter"
				) {
					throw new Error(
						`Kimi stream returned unsupported finish_reason '${rawChoice.finish_reason}'`,
					);
				}
				if (
					state.finishReason &&
					state.finishReason !== rawChoice.finish_reason
				) {
					throw new Error("Kimi stream returned conflicting finish reasons");
				}
				state.finishReason = rawChoice.finish_reason;
			}
		}
		return outputs;
	} catch (error) {
		outputs.push(
			...failStream(
				state,
				originalRequest,
				error instanceof Error ? error.message : String(error),
			),
		);
		return outputs;
	}
}

function createKimiStreamState(originalRequest: JsonRecord): KimiStreamState {
	return {
		sequence: 0,
		responseId: generateId("resp"),
		model:
			typeof originalRequest.model === "string"
				? originalRequest.model.replace(/^kimi\//, "")
				: "unknown",
		createdAt: Math.floor(Date.now() / 1000),
		started: false,
		ended: false,
		finishReason: null,
		usage: {},
		nextOutputIndex: 0,
		reasoningItems: new Map(),
		messageItems: new Map(),
		toolItems: new Map(),
		bufferedChars: 0,
		fragmentCount: 0,
	};
}

export async function transformKimiChatResponseToOpenAIResponses(
	response: Response,
	originalRequest: JsonRecord,
): Promise<Response> {
	if (originalRequest.stream === true && isStreamingResponse(response)) {
		const state = createKimiStreamState(originalRequest);
		const reverseByWireName =
			projectResponsesTools(originalRequest).reverseByWireName;
		return createTransformedSseResponse(
			response,
			(frame) =>
				transformKimiFrame(frame, state, originalRequest, reverseByWireName),
			{
				maxBufferedChars: MAX_SSE_FRAME_CHARS,
				requireCompleteFrames: true,
				finalize: () =>
					state.finishReason
						? completeStream(state, originalRequest, reverseByWireName)
						: failStream(
								state,
								originalRequest,
								"Kimi stream reached EOF without a valid finish_reason",
							),
				onError: (error) =>
					failStream(
						state,
						originalRequest,
						error instanceof Error ? error.message : String(error),
					),
			},
		);
	}

	let body: JsonRecord;
	try {
		const parsed = JSON.parse(await response.text());
		if (!isRecord(parsed)) throw new Error("not an object");
		body = parsed;
	} catch {
		return jsonResponse(
			failedResponse(originalRequest),
			response,
			"application/json; charset=utf-8",
		);
	}
	return jsonResponse(
		convertChatBody(body, originalRequest),
		response,
		"application/json; charset=utf-8",
	);
}
