import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../../types";

export function normalizeCodexResponsesRequest(input: JsonRecord): JsonRecord {
	const output: JsonRecord = { ...input };
	output.stream = true;
	output.store = false;
	output.include = ["reasoning.encrypted_content"];

	if (
		!isRecord(output.reasoning) ||
		typeof output.reasoning.effort !== "string"
	) {
		output.reasoning = {
			...(isRecord(output.reasoning) ? output.reasoning : {}),
		};
		(output.reasoning as JsonRecord).effort = "medium";
	}
	(output.reasoning as JsonRecord).summary = "auto";

	delete output.max_output_tokens;
	delete output.max_completion_tokens;
	delete output.temperature;
	delete output.top_p;
	delete output.truncation;
	delete output.user;

	if (
		typeof output.service_tier === "string" &&
		output.service_tier !== "priority"
	) {
		delete output.service_tier;
	}

	if (typeof output.input === "string") {
		output.input = [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: output.input }],
			},
		];
	} else if (Array.isArray(output.input)) {
		output.input = output.input.map((item) => {
			if (!isRecord(item) || item.role !== "system") {
				return item;
			}
			return { ...item, role: "developer" };
		});
	}

	normalizeCodexBuiltinTools(output);
	return output;
}

function normalizeCodexBuiltinTools(output: JsonRecord): void {
	if (Array.isArray(output.tools)) {
		output.tools = output.tools.map((tool) =>
			isRecord(tool) && typeof tool.type === "string"
				? { ...tool, type: normalizeCodexBuiltinToolType(tool.type) }
				: tool,
		);
	}

	const toolChoice = isRecord(output.tool_choice) ? output.tool_choice : null;
	if (!toolChoice) {
		return;
	}

	if (typeof toolChoice.type === "string") {
		output.tool_choice = {
			...toolChoice,
			type: normalizeCodexBuiltinToolType(toolChoice.type),
		};
	}
	if (Array.isArray(toolChoice.tools)) {
		output.tool_choice = {
			...toolChoice,
			tools: toolChoice.tools.map((tool: unknown) =>
				isRecord(tool) && typeof tool.type === "string"
					? { ...tool, type: normalizeCodexBuiltinToolType(tool.type) }
					: tool,
			),
		};
	}
}

function normalizeCodexBuiltinToolType(type: string): string {
	if (
		type === "web_search_preview" ||
		type === "web_search_preview_2025_03_11"
	) {
		return "web_search";
	}
	return type;
}
