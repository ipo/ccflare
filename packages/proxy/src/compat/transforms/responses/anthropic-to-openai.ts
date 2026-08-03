import { isRecord } from "@ccflare/types";
import type {
	AnthropicToChatStreamState,
	AnthropicToResponsesStreamState,
	AnthropicUsage,
	JsonRecord,
	SseFrame,
} from "../../types";
import { buildAnthropicResponsesOutput } from "../anthropic-responses-output";
import { applyOpenAIResponsesRequestFields } from "../request-context";
import {
	convertAnthropicContentToOpenAIResponsesOutput,
	convertAnthropicJsonToOpenAIChatMessage,
	formatAnthropicCompatNotice,
} from "../response-content";
import {
	anthropicStopToOpenAIFinish,
	buildChatChunk,
	buildSseFrame,
	createTransformedSseResponse,
	generateId,
	isStreamingResponse,
	jsonResponse,
	maybeParseJson,
	toOpenAIUsage,
} from "../shared";

export function transformAnthropicResponseToOpenAIChat(
	response: Response,
): Promise<Response> {
	return transformAnthropicResponse(response, "openai-chat-completions");
}

export function transformAnthropicResponseToOpenAIResponses(
	response: Response,
	originalRequest?: JsonRecord,
): Promise<Response> {
	return transformAnthropicResponse(
		response,
		"openai-responses",
		originalRequest,
	);
}

async function transformAnthropicResponse(
	response: Response,
	route: "openai-chat-completions" | "openai-responses",
	originalRequest?: JsonRecord,
): Promise<Response> {
	if (isStreamingResponse(response)) {
		if (route === "openai-chat-completions") {
			const state: AnthropicToChatStreamState = {
				id: generateId("chatcmpl"),
				model: "",
				created: Math.floor(Date.now() / 1000),
				usage: {},
				finishReason: null,
				textIndex: 0,
				toolIndexes: new Map(),
				toolNames: new Map(),
			};
			return createTransformedSseResponse(response, (frame) =>
				transformAnthropicFrameToOpenAIChat(frame, state),
			);
		}

		const state: AnthropicToResponsesStreamState = {
			sequence: 0,
			responseId: generateId("resp"),
			model: "",
			createdAt: Math.floor(Date.now() / 1000),
			noticeCount: 0,
			messageItemId: null,
			usage: {},
			messageItemIds: new Map(),
			messageTexts: new Map(),
			functionCallIds: new Map(),
			functionNames: new Map(),
			functionArguments: new Map(),
			reasoningIds: new Map(),
			reasoningTexts: new Map(),
		};
		return createTransformedSseResponse(response, (frame) =>
			transformAnthropicFrameToOpenAIResponses(frame, state, originalRequest),
		);
	}

	const body = (await response.json()) as JsonRecord;
	if (route === "openai-chat-completions") {
		return jsonResponse(
			convertAnthropicJsonToOpenAIChat(body),
			response,
			"application/json; charset=utf-8",
		);
	}
	return jsonResponse(
		convertAnthropicJsonToOpenAIResponses(body, originalRequest),
		response,
		"application/json; charset=utf-8",
	);
}

function convertAnthropicJsonToOpenAIChat(body: JsonRecord): JsonRecord {
	return {
		id: typeof body.id === "string" ? body.id : generateId("chatcmpl"),
		object: "chat.completion",
		created:
			typeof body.created_at === "number"
				? body.created_at
				: Math.floor(Date.now() / 1000),
		model: typeof body.model === "string" ? body.model : "unknown",
		choices: [
			{
				index: 0,
				message: convertAnthropicJsonToOpenAIChatMessage(body),
				finish_reason: anthropicStopToOpenAIFinish(
					typeof body.stop_reason === "string" ? body.stop_reason : null,
				),
			},
		],
		usage: toOpenAIUsage(
			isRecord(body.usage) ? (body.usage as AnthropicUsage) : undefined,
		),
	};
}

function convertAnthropicJsonToOpenAIResponses(
	body: JsonRecord,
	originalRequest?: JsonRecord,
): JsonRecord {
	return applyOpenAIResponsesRequestFields(
		{
			id: typeof body.id === "string" ? body.id : generateId("resp"),
			object: "response",
			created_at:
				typeof body.created_at === "number"
					? body.created_at
					: Math.floor(Date.now() / 1000),
			model: typeof body.model === "string" ? body.model : "unknown",
			status: "completed",
			output: convertAnthropicContentToOpenAIResponsesOutput(body.content),
			usage: toOpenAIUsage(
				isRecord(body.usage) ? (body.usage as AnthropicUsage) : undefined,
			),
		},
		originalRequest,
	);
}

function emitSyntheticReasoningNotice(
	state: AnthropicToResponsesStreamState,
	notice: string,
	nextSequence: () => number,
): string[] {
	const outputIndex = 1000 + state.noticeCount;
	state.noticeCount += 1;
	const reasoningId = `${state.responseId}_notice_${outputIndex}`;
	state.reasoningIds.set(outputIndex, reasoningId);
	state.reasoningTexts.set(outputIndex, notice);

	return [
		buildSseFrame("response.output_item.added", {
			type: "response.output_item.added",
			sequence_number: nextSequence(),
			output_index: outputIndex,
			item: {
				id: reasoningId,
				type: "reasoning",
				status: "in_progress",
				summary: [],
			},
		}),
		buildSseFrame("response.reasoning_summary_text.delta", {
			type: "response.reasoning_summary_text.delta",
			sequence_number: nextSequence(),
			output_index: outputIndex,
			item_id: reasoningId,
			summary_index: 0,
			delta: notice,
		}),
		buildSseFrame("response.reasoning_summary_text.done", {
			type: "response.reasoning_summary_text.done",
			sequence_number: nextSequence(),
			output_index: outputIndex,
			item_id: reasoningId,
			summary_index: 0,
			text: notice,
		}),
		buildSseFrame("response.output_item.done", {
			type: "response.output_item.done",
			sequence_number: nextSequence(),
			output_index: outputIndex,
			item: {
				id: reasoningId,
				type: "reasoning",
				status: "completed",
				summary: [{ type: "summary_text", text: notice }],
			},
		}),
	];
}

function transformAnthropicFrameToOpenAIChat(
	frame: SseFrame,
	state: AnthropicToChatStreamState,
): string[] {
	const payload = maybeParseJson(frame.data);
	if (!isRecord(payload)) {
		return [];
	}

	const outputs: string[] = [];
	const type = typeof payload.type === "string" ? payload.type : frame.event;
	const notice = formatAnthropicCompatNotice(payload);
	if (notice) {
		outputs.push(
			buildSseFrame(
				null,
				buildChatChunk(state, {
					reasoning_content: notice,
				}),
			),
		);
		return outputs;
	}
	if (type === "message_start" && isRecord(payload.message)) {
		state.id =
			typeof payload.message.id === "string" ? payload.message.id : state.id;
		state.model =
			typeof payload.message.model === "string"
				? payload.message.model
				: state.model;
		state.created =
			typeof payload.message.created_at === "number"
				? payload.message.created_at
				: state.created;
		state.usage = toOpenAIUsage(
			isRecord(payload.message.usage)
				? (payload.message.usage as AnthropicUsage)
				: undefined,
		);
		outputs.push(
			buildSseFrame(null, buildChatChunk(state, { role: "assistant" })),
		);
		return outputs;
	}
	if (type === "content_block_delta" && isRecord(payload.delta)) {
		if (
			payload.delta.type === "text_delta" &&
			typeof payload.delta.text === "string"
		) {
			outputs.push(
				buildSseFrame(
					null,
					buildChatChunk(state, { content: payload.delta.text }),
				),
			);
		}
		if (
			payload.delta.type === "thinking_delta" &&
			typeof payload.delta.thinking === "string"
		) {
			outputs.push(
				buildSseFrame(
					null,
					buildChatChunk(state, {
						reasoning_content: payload.delta.thinking,
					}),
				),
			);
		}
		if (
			payload.delta.type === "input_json_delta" &&
			typeof payload.delta.partial_json === "string"
		) {
			const sourceIndex = typeof payload.index === "number" ? payload.index : 0;
			const toolId = state.toolIndexes.get(sourceIndex) ?? generateId("call");
			const toolName = state.toolNames.get(sourceIndex) ?? "tool";
			state.toolIndexes.set(sourceIndex, toolId);
			state.toolNames.set(sourceIndex, toolName);
			outputs.push(
				buildSseFrame(
					null,
					buildChatChunk(state, {
						tool_calls: [
							{
								index: sourceIndex,
								id: toolId,
								type: "function",
								function: {
									name: toolName,
									arguments: payload.delta.partial_json,
								},
							},
						],
					}),
				),
			);
		}
		return outputs;
	}
	if (type === "content_block_start" && isRecord(payload.content_block)) {
		if (payload.content_block.type === "tool_use") {
			const sourceIndex = typeof payload.index === "number" ? payload.index : 0;
			const toolId =
				typeof payload.content_block.id === "string"
					? payload.content_block.id
					: generateId("call");
			const toolName =
				typeof payload.content_block.name === "string"
					? payload.content_block.name
					: "tool";
			state.toolIndexes.set(sourceIndex, toolId);
			state.toolNames.set(sourceIndex, toolName);
			outputs.push(
				buildSseFrame(
					null,
					buildChatChunk(state, {
						tool_calls: [
							{
								index: sourceIndex,
								id: toolId,
								type: "function",
								function: { name: toolName, arguments: "" },
							},
						],
					}),
				),
			);
		}
		return outputs;
	}
	if (type === "message_delta") {
		state.finishReason = anthropicStopToOpenAIFinish(
			isRecord(payload.delta) && typeof payload.delta.stop_reason === "string"
				? payload.delta.stop_reason
				: null,
		);
		if (isRecord(payload.usage)) {
			state.usage = toOpenAIUsage(payload.usage as AnthropicUsage);
		}
		return outputs;
	}
	if (type === "message_stop") {
		outputs.push(
			buildSseFrame(
				null,
				buildChatChunk(
					state,
					{},
					{ finishReason: state.finishReason ?? "stop", usage: state.usage },
				),
			),
		);
		outputs.push(buildSseFrame(null, "[DONE]"));
		return outputs;
	}

	return outputs;
}

function transformAnthropicFrameToOpenAIResponses(
	frame: SseFrame,
	state: AnthropicToResponsesStreamState,
	originalRequest?: JsonRecord,
): string[] {
	const payload = maybeParseJson(frame.data);
	if (!isRecord(payload)) return [];

	const outputs: string[] = [];
	const nextSequence = () => ++state.sequence;
	const type = typeof payload.type === "string" ? payload.type : frame.event;
	const notice = formatAnthropicCompatNotice(payload);
	if (notice) {
		return emitSyntheticReasoningNotice(state, notice, nextSequence);
	}

	if (type === "message_start" && isRecord(payload.message)) {
		state.responseId =
			typeof payload.message.id === "string"
				? payload.message.id
				: state.responseId;
		state.model =
			typeof payload.message.model === "string"
				? payload.message.model
				: state.model;
		state.createdAt =
			typeof payload.message.created_at === "number"
				? payload.message.created_at
				: state.createdAt;
		state.usage = toOpenAIUsage(
			isRecord(payload.message.usage)
				? (payload.message.usage as AnthropicUsage)
				: undefined,
		);
		outputs.push(
			buildSseFrame("response.created", {
				type: "response.created",
				sequence_number: nextSequence(),
				response: {
					id: state.responseId,
					object: "response",
					created_at: state.createdAt,
					status: "in_progress",
					model: state.model,
					output: [],
				},
			}),
		);
		outputs.push(
			buildSseFrame("response.in_progress", {
				type: "response.in_progress",
				sequence_number: nextSequence(),
				response: {
					id: state.responseId,
					object: "response",
					created_at: state.createdAt,
					status: "in_progress",
					model: state.model,
				},
			}),
		);
		return outputs;
	}

	if (type === "content_block_start" && isRecord(payload.content_block)) {
		const outputIndex = typeof payload.index === "number" ? payload.index : 0;
		if (payload.content_block.type === "text") {
			state.messageItemId = `${state.responseId}_msg_${outputIndex}`;
			state.messageItemIds.set(outputIndex, state.messageItemId);
			state.messageTexts.set(outputIndex, "");
			outputs.push(
				buildSseFrame("response.output_item.added", {
					type: "response.output_item.added",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item: {
						id: state.messageItemId,
						type: "message",
						status: "in_progress",
						role: "assistant",
						content: [],
					},
				}),
			);
			outputs.push(
				buildSseFrame("response.content_part.added", {
					type: "response.content_part.added",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item_id: state.messageItemId,
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
		if (payload.content_block.type === "tool_use") {
			const callId =
				typeof payload.content_block.id === "string"
					? payload.content_block.id
					: generateId("call");
			const name =
				typeof payload.content_block.name === "string"
					? payload.content_block.name
					: "tool";
			state.functionCallIds.set(outputIndex, callId);
			state.functionNames.set(outputIndex, name);
			state.functionArguments.set(outputIndex, "");
			outputs.push(
				buildSseFrame("response.output_item.added", {
					type: "response.output_item.added",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item: {
						id: `fc_${callId}`,
						type: "function_call",
						status: "in_progress",
						call_id: callId,
						name,
						arguments: "",
					},
				}),
			);
		}
		if (payload.content_block.type === "thinking") {
			const reasoningId = `${state.responseId}_reasoning_${outputIndex}`;
			state.reasoningIds.set(outputIndex, reasoningId);
			state.reasoningTexts.set(outputIndex, "");
			outputs.push(
				buildSseFrame("response.output_item.added", {
					type: "response.output_item.added",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item: {
						id: reasoningId,
						type: "reasoning",
						status: "in_progress",
						summary: [],
					},
				}),
			);
		}
		return outputs;
	}

	if (type === "content_block_delta" && isRecord(payload.delta)) {
		const outputIndex = typeof payload.index === "number" ? payload.index : 0;
		if (
			payload.delta.type === "text_delta" &&
			typeof payload.delta.text === "string"
		) {
			state.messageTexts.set(
				outputIndex,
				(state.messageTexts.get(outputIndex) ?? "") + payload.delta.text,
			);
			outputs.push(
				buildSseFrame("response.output_text.delta", {
					type: "response.output_text.delta",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item_id: state.messageItemId,
					content_index: 0,
					delta: payload.delta.text,
				}),
			);
		}
		if (
			payload.delta.type === "input_json_delta" &&
			typeof payload.delta.partial_json === "string"
		) {
			const callId =
				state.functionCallIds.get(outputIndex) ?? generateId("call");
			state.functionArguments.set(
				outputIndex,
				(state.functionArguments.get(outputIndex) ?? "") +
					payload.delta.partial_json,
			);
			outputs.push(
				buildSseFrame("response.function_call_arguments.delta", {
					type: "response.function_call_arguments.delta",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item_id: `fc_${callId}`,
					delta: payload.delta.partial_json,
				}),
			);
		}
		if (
			payload.delta.type === "thinking_delta" &&
			typeof payload.delta.thinking === "string"
		) {
			state.reasoningTexts.set(
				outputIndex,
				(state.reasoningTexts.get(outputIndex) ?? "") + payload.delta.thinking,
			);
			const reasoningId = state.reasoningIds.get(outputIndex);
			if (reasoningId) {
				outputs.push(
					buildSseFrame("response.reasoning_summary_text.delta", {
						type: "response.reasoning_summary_text.delta",
						sequence_number: nextSequence(),
						output_index: outputIndex,
						item_id: reasoningId,
						summary_index: 0,
						delta: payload.delta.thinking,
					}),
				);
			}
		}
		return outputs;
	}

	if (type === "content_block_stop") {
		const outputIndex = typeof payload.index === "number" ? payload.index : 0;
		const callId = state.functionCallIds.get(outputIndex);
		const reasoningId = state.reasoningIds.get(outputIndex);
		if (callId) {
			const argumentsText = state.functionArguments.get(outputIndex) ?? "";
			outputs.push(
				buildSseFrame("response.function_call_arguments.done", {
					type: "response.function_call_arguments.done",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item_id: `fc_${callId}`,
					arguments: argumentsText,
				}),
			);
			outputs.push(
				buildSseFrame("response.output_item.done", {
					type: "response.output_item.done",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item: {
						id: `fc_${callId}`,
						type: "function_call",
						status: "completed",
						call_id: callId,
						name: state.functionNames.get(outputIndex) ?? "tool",
						arguments: argumentsText,
					},
				}),
			);
			return outputs;
		}
		if (reasoningId) {
			const reasoningText = state.reasoningTexts.get(outputIndex) ?? "";
			outputs.push(
				buildSseFrame("response.reasoning_summary_text.done", {
					type: "response.reasoning_summary_text.done",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item_id: reasoningId,
					summary_index: 0,
					text: reasoningText,
				}),
			);
			outputs.push(
				buildSseFrame("response.output_item.done", {
					type: "response.output_item.done",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item: {
						id: reasoningId,
						type: "reasoning",
						status: "completed",
						summary: [
							{
								type: "summary_text",
								text: reasoningText,
							},
						],
					},
				}),
			);
			return outputs;
		}
		if (state.messageItemId) {
			const messageText = state.messageTexts.get(outputIndex) ?? "";
			outputs.push(
				buildSseFrame("response.output_text.done", {
					type: "response.output_text.done",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item_id: state.messageItemId,
					content_index: 0,
					text: messageText,
				}),
			);
			outputs.push(
				buildSseFrame("response.content_part.done", {
					type: "response.content_part.done",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item_id: state.messageItemId,
					content_index: 0,
					part: {
						type: "output_text",
						text: messageText,
						annotations: [],
						logprobs: [],
					},
				}),
			);
			outputs.push(
				buildSseFrame("response.output_item.done", {
					type: "response.output_item.done",
					sequence_number: nextSequence(),
					output_index: outputIndex,
					item: {
						id: state.messageItemId,
						type: "message",
						status: "completed",
						role: "assistant",
						content: [{ type: "output_text", text: messageText }],
					},
				}),
			);
			state.messageItemId = null;
		}
		return outputs;
	}

	if (type === "message_delta" && isRecord(payload.usage)) {
		state.usage = toOpenAIUsage(payload.usage as AnthropicUsage);
		return outputs;
	}

	if (type === "message_stop") {
		const completedResponse = applyOpenAIResponsesRequestFields(
			{
				id: state.responseId,
				object: "response",
				created_at: state.createdAt,
				model: state.model,
				status: "completed",
				output: buildAnthropicResponsesOutput(state),
				usage: state.usage,
			},
			originalRequest,
		);
		outputs.push(
			buildSseFrame("response.completed", {
				type: "response.completed",
				sequence_number: nextSequence(),
				response: completedResponse,
			}),
		);
	}

	return outputs;
}
