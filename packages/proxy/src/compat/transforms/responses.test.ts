import { describe, expect, it } from "bun:test";
import {
	transformAnthropicResponseToOpenAIChat,
	transformAnthropicResponseToOpenAIResponses,
	transformKimiChatResponseToOpenAIResponses,
} from "./responses";

describe("transformAnthropicResponseToOpenAIResponses", () => {
	it("reverse-maps ordinary, namespaced, and custom tool calls in JSON", async () => {
		const response = await transformAnthropicResponseToOpenAIResponses(
			new Response(
				JSON.stringify({
					id: "msg_tools",
					model: "claude-sonnet-5",
					content: [
						{
							type: "tool_use",
							id: "call_1",
							name: "read",
							input: { path: "a" },
						},
						{
							type: "tool_use",
							id: "call_2",
							name: "agents.spawn",
							input: { task: "test" },
						},
						{
							type: "tool_use",
							id: "call_3",
							name: "apply_patch",
							input: { input: "*** Begin Patch" },
						},
					],
					usage: { input_tokens: 3, output_tokens: 4 },
				}),
				{ headers: { "content-type": "application/json" } },
			),
			{
				tools: [
					{ type: "function", name: "read", parameters: {} },
					{
						type: "namespace",
						name: "agents.",
						tools: [{ type: "function", name: "spawn", parameters: {} }],
					},
					{ type: "custom", name: "apply_patch" },
				],
			},
		);

		const body = (await response.json()) as { output: unknown[] };
		expect(body.output).toEqual([
			expect.objectContaining({
				type: "function_call",
				call_id: "call_1",
				name: "read",
				arguments: '{"path":"a"}',
			}),
			expect.objectContaining({
				type: "function_call",
				call_id: "call_2",
				name: "spawn",
				namespace: "agents.",
				arguments: '{"task":"test"}',
			}),
			expect.objectContaining({
				type: "custom_tool_call",
				call_id: "call_3",
				name: "apply_patch",
				input: "*** Begin Patch",
			}),
		]);
	});

	it("reverse-maps interleaved parallel tool calls in SSE", async () => {
		const response = await transformAnthropicResponseToOpenAIResponses(
			new Response(
				[
					"event: message_start",
					'data: {"type":"message_start","message":{"id":"msg_parallel","model":"claude-sonnet-5","usage":{"input_tokens":1,"output_tokens":0}}}',
					"",
					"event: content_block_start",
					'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"read","input":{}}}',
					"",
					"event: content_block_start",
					'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_2","name":"agents.spawn","input":{}}}',
					"",
					"event: content_block_start",
					'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_3","name":"apply_patch","input":{}}}',
					"",
					"event: content_block_delta",
					'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"task\\":\\"test\\"}"}}',
					"",
					"event: content_block_delta",
					'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}',
					"",
					"event: content_block_delta",
					'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"input\\":\\"patch\\"}"}}',
					"",
					"event: content_block_stop",
					'data: {"type":"content_block_stop","index":1}',
					"",
					"event: content_block_stop",
					'data: {"type":"content_block_stop","index":0}',
					"",
					"event: content_block_stop",
					'data: {"type":"content_block_stop","index":2}',
					"",
					"event: message_stop",
					'data: {"type":"message_stop"}',
					"",
					"",
				].join("\n"),
				{ headers: { "content-type": "text/event-stream" } },
			),
			{
				tools: [
					{ type: "function", name: "read", parameters: {} },
					{
						type: "namespace",
						name: "agents.",
						tools: [{ type: "function", name: "spawn", parameters: {} }],
					},
					{ type: "custom", name: "apply_patch" },
				],
			},
		);

		const text = await response.text();
		expect(text).toContain('"type":"custom_tool_call","status":"in_progress"');
		expect(text).toContain('"type":"response.custom_tool_call_input.delta"');
		expect(text).toContain('"name":"spawn","namespace":"agents."');
		expect(text).toContain('"type":"custom_tool_call","status":"completed"');
		const completedLine = text
			.split("\n")
			.find((line) => line.includes('"type":"response.completed"'));
		expect(completedLine).toBeDefined();
		const completed = JSON.parse(completedLine?.slice(6) ?? "{}") as {
			response: { output: unknown[] };
		};
		expect(completed.response.output).toEqual([
			expect.objectContaining({
				type: "function_call",
				call_id: "call_1",
				name: "read",
			}),
			expect.objectContaining({
				type: "function_call",
				call_id: "call_2",
				name: "spawn",
				namespace: "agents.",
			}),
			expect.objectContaining({
				type: "custom_tool_call",
				call_id: "call_3",
				name: "apply_patch",
				input: "patch",
			}),
		]);
	});

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

describe("transformKimiChatResponseToOpenAIResponses", () => {
	it("converts text, reasoning, parallel tools, usage, and reverse mappings", async () => {
		const response = await transformKimiChatResponseToOpenAIResponses(
			new Response(
				JSON.stringify({
					id: "chatcmpl_1",
					created: 10,
					model: "k3",
					choices: [
						{
							message: {
								content: "done",
								reasoning: "thought",
								tool_calls: [
									{
										id: "call_1",
										function: {
											name: "agents.spawn",
											arguments: '{"task":"test"}',
										},
									},
									{
										id: "call_2",
										function: {
											name: "patch",
											arguments: '{"input":"diff"}',
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 5,
						total_tokens: 15,
						prompt_tokens_details: { cached_tokens: 3 },
						completion_tokens_details: { reasoning_tokens: 2 },
					},
				}),
			),
			{
				model: "kimi/k3",
				input: "hello",
				metadata: { fixture: "kimi-json" },
				tools: [
					{
						type: "namespace",
						name: "agents.",
						tools: [{ type: "function", name: "spawn", parameters: {} }],
					},
					{ type: "custom", name: "patch" },
				],
			},
		);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({
			id: "chatcmpl_1",
			object: "response",
			created_at: 10,
			model: "k3",
			status: "completed",
			output: [
				expect.objectContaining({
					type: "reasoning",
					summary: [{ type: "summary_text", text: "thought" }],
				}),
				expect.objectContaining({
					type: "message",
					content: [{ type: "output_text", text: "done", annotations: [] }],
				}),
				expect.objectContaining({
					type: "function_call",
					call_id: "call_1",
					name: "spawn",
					namespace: "agents.",
					arguments: '{"task":"test"}',
				}),
				expect.objectContaining({
					type: "custom_tool_call",
					call_id: "call_2",
					name: "patch",
					input: "diff",
				}),
			],
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				total_tokens: 15,
				input_tokens_details: { cached_tokens: 3 },
				output_tokens_details: { reasoning_tokens: 2 },
			},
			metadata: { fixture: "kimi-json" },
			tools: expect.any(Array),
		});
	});

	it("maps length to incomplete and malformed JSON to failed", async () => {
		const incomplete = await transformKimiChatResponseToOpenAIResponses(
			new Response(
				JSON.stringify({
					model: "k3",
					choices: [
						{ message: { content: "partial" }, finish_reason: "length" },
					],
				}),
			),
			{ model: "kimi/k3", input: "hello" },
		);
		expect(await incomplete.json()).toEqual(
			expect.objectContaining({
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
			}),
		);

		const failed = await transformKimiChatResponseToOpenAIResponses(
			new Response("not json"),
			{ model: "kimi/k3", input: "hello" },
		);
		expect(await failed.json()).toEqual(
			expect.objectContaining({
				status: "failed",
				error: expect.objectContaining({ code: "invalid_upstream_response" }),
			}),
		);
	});
});
