import { describe, expect, it } from "bun:test";
import {
	transformAnthropicResponseToOpenAIChat,
	transformAnthropicResponseToOpenAIResponses,
} from "./responses";

describe("transformAnthropicResponseToOpenAIResponses", () => {
	it("preserves original request fields on response.completed stream events", async () => {
		const response = await transformAnthropicResponseToOpenAIResponses(
			new Response(
				[
					"event: message_start",
					'data: {"type":"message_start","message":{"id":"msg_test","model":"claude-opus-4.6","usage":{"input_tokens":10,"output_tokens":0}}}',
					"",
					"event: content_block_start",
					'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
					"",
					"event: content_block_delta",
					'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"translated"}}',
					"",
					"event: content_block_stop",
					'data: {"type":"content_block_stop","index":0}',
					"",
					"event: message_delta",
					'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":5}}',
					"",
					"event: message_stop",
					'data: {"type":"message_stop"}',
					"",
					"",
				].join("\n"),
				{
					status: 200,
					headers: { "content-type": "text/event-stream; charset=utf-8" },
				},
			),
			{
				model: "anthropic/claude-opus-4.6",
				instructions: "Keep it short.",
				metadata: { source: "compat-stream-test" },
				tool_choice: "auto",
			},
		);

		const text = await response.text();
		expect(text).toContain('"type":"response.completed"');
		expect(text).toContain('"instructions":"Keep it short."');
		expect(text).toContain('"tool_choice":"auto"');
		expect(text).toContain('"metadata":{"source":"compat-stream-test"}');
		expect(text).toContain('"output":[{"id":"msg_test_msg_0","type":"message"');
		expect(text).toContain('"text":"translated"');
		expect(text).toContain('"type":"response.output_text.done"');
		expect(text).toContain('"response.output_text.done","sequence_number":');
		expect(text).toContain('"text":"translated"');
		expect(text).toContain('"type":"response.content_part.done"');
		expect(text).toContain('"part":{"type":"output_text","text":"translated"');
		const outputDoneIndex = text.indexOf('"type":"response.output_item.done"');
		const completedIndex = text.indexOf('"type":"response.completed"');
		expect(outputDoneIndex).toBeGreaterThan(-1);
		expect(completedIndex).toBeGreaterThan(outputDoneIndex);
	});

	it("maps Claude Code sentinel events into openai chat reasoning notices", async () => {
		const response = await transformAnthropicResponseToOpenAIChat(
			new Response(
				[
					'data: {"type":"system","subtype":"session_state_changed","state":"requires_action","session_id":"sess_123"}',
					"",
					'data: {"type":"tool_progress","tool_use_id":"toolu_123","tool_name":"Bash","elapsed_time_seconds":2.5,"session_id":"sess_123"}',
					"",
					"",
				].join("\n"),
				{
					status: 200,
					headers: { "content-type": "text/event-stream; charset=utf-8" },
				},
			),
		);

		const text = await response.text();
		expect(text).toContain(
			'"reasoning_content":"Session state changed: requires_action"',
		);
		expect(text).toContain('"reasoning_content":"Tool progress: Bash (2.5s)"');
	});

	it("maps Claude Code sentinel events into openai responses reasoning items", async () => {
		const response = await transformAnthropicResponseToOpenAIResponses(
			new Response(
				[
					"event: message_start",
					'data: {"type":"message_start","message":{"id":"msg_test","model":"claude-opus-4.6","usage":{"input_tokens":10,"output_tokens":0}}}',
					"",
					'data: {"type":"tool_use_summary","summary":"Searched in auth/","preceding_tool_use_ids":["toolu_1","toolu_2"],"session_id":"sess_123"}',
					"",
					"event: message_stop",
					'data: {"type":"message_stop"}',
					"",
					"",
				].join("\n"),
				{
					status: 200,
					headers: { "content-type": "text/event-stream; charset=utf-8" },
				},
			),
		);

		const text = await response.text();
		expect(text).toContain('"type":"response.output_item.added"');
		expect(text).toContain('"type":"reasoning"');
		expect(text).toContain('"delta":"Tool summary: Searched in auth/"');
		expect(text).toContain('"text":"Tool summary: Searched in auth/"');
		expect(text).toContain(
			'"summary":[{"type":"summary_text","text":"Tool summary: Searched in auth/"}]',
		);
	});
});
