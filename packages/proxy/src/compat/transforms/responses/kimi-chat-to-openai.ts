import { isRecord } from "@ccflare/types";
import type { JsonRecord, OpenAIUsage } from "../../types";
import { applyOpenAIResponsesRequestFields } from "../request-context";
import {
	projectResponsesTools,
	reverseResponsesToolCall,
} from "../responses-tool-projection";
import { generateId, jsonResponse } from "../shared";

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
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens:
			typeof usage.total_tokens === "number"
				? usage.total_tokens
				: inputTokens + outputTokens,
		...(typeof promptDetails?.cached_tokens === "number"
			? { input_tokens_details: { cached_tokens: promptDetails.cached_tokens } }
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

function failedResponse(originalRequest: JsonRecord): JsonRecord {
	return applyOpenAIResponsesRequestFields(
		{
			id: generateId("resp"),
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			model:
				typeof originalRequest.model === "string"
					? originalRequest.model.replace(/^kimi\//, "")
					: "unknown",
			status: "failed",
			error: {
				code: "invalid_upstream_response",
				message: "Kimi returned malformed Chat Completions JSON",
			},
			output: [],
			usage: {},
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

export async function transformKimiChatResponseToOpenAIResponses(
	response: Response,
	originalRequest: JsonRecord,
): Promise<Response> {
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
