import type { AnthropicToResponsesStreamState, JsonRecord } from "../types";

export function buildAnthropicResponsesOutput(
	state: AnthropicToResponsesStreamState,
): JsonRecord[] {
	const outputIndexes = new Set<number>([
		...state.messageItemIds.keys(),
		...state.functionCallIds.keys(),
		...state.reasoningIds.keys(),
	]);

	return Array.from(outputIndexes)
		.sort((a, b) => a - b)
		.flatMap((outputIndex) => {
			const items: JsonRecord[] = [];
			const reasoningId = state.reasoningIds.get(outputIndex);
			if (reasoningId) {
				items.push({
					id: reasoningId,
					type: "reasoning",
					status: "completed",
					summary: [
						{
							type: "summary_text",
							text: state.reasoningTexts.get(outputIndex) ?? "",
						},
					],
				});
			}

			const messageItemId = state.messageItemIds.get(outputIndex);
			if (messageItemId) {
				items.push({
					id: messageItemId,
					type: "message",
					status: "completed",
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: state.messageTexts.get(outputIndex) ?? "",
						},
					],
				});
			}

			const callId = state.functionCallIds.get(outputIndex);
			if (callId) {
				const name = state.functionNames.get(outputIndex) ?? "tool";
				const namespace = state.functionNamespaces.get(outputIndex);
				const argumentsText = state.functionArguments.get(outputIndex) ?? "";
				if (state.functionTypes.get(outputIndex) === "custom_tool_call") {
					let input = "";
					try {
						const parsed = JSON.parse(argumentsText) as { input?: unknown };
						input = typeof parsed.input === "string" ? parsed.input : "";
					} catch {
						input = "";
					}
					items.push({
						id: `ctc_${callId}`,
						type: "custom_tool_call",
						status: "completed",
						call_id: callId,
						name,
						...(namespace ? { namespace } : {}),
						input,
					});
				} else {
					items.push({
						id: `fc_${callId}`,
						type: "function_call",
						status: "completed",
						call_id: callId,
						name,
						...(namespace ? { namespace } : {}),
						arguments: argumentsText,
					});
				}
			}

			return items;
		});
}
