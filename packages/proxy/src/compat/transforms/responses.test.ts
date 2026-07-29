import { describe, expect, it } from "bun:test";
import {
	transformAnthropicResponseToOpenAIChat,
	transformAnthropicResponseToOpenAIResponses,
	transformKimiChatResponseToOpenAIResponses,
} from "./responses";

function kimiSse(...payloads: Array<JsonRecord | "[DONE]">): string {
	return `${payloads
		.map((payload) =>
			payload === "[DONE]"
				? "data: [DONE]"
				: `data: ${JSON.stringify(payload)}`,
		)
		.join("\n\n")}\n\n`;
}

type JsonRecord = Record<string, unknown>;

function parseResponseEvents(text: string): JsonRecord[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: {") && !line.includes("[DONE]"))
		.map((line) => JSON.parse(line.slice(6)) as JsonRecord);
}

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

	it("streams ordered reasoning and text events into a completed response", async () => {
		const response = await transformKimiChatResponseToOpenAIResponses(
			new Response(
				kimiSse(
					{
						id: "chatcmpl_ordered",
						created: 11,
						model: "k3",
						choices: [
							{
								index: 0,
								delta: {
									reasoning_content: "first thought",
									content: "first answer",
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								index: 0,
								delta: {
									reasoning: " second thought",
									content: " second answer",
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 7,
							completion_tokens: 5,
							total_tokens: 12,
						},
					},
					"[DONE]",
				),
				{
					status: 206,
					headers: {
						"content-type": "text/event-stream",
						"x-kimi-trace": "trace-1",
					},
				},
			),
			{
				model: "kimi/k3",
				stream: true,
				input: "hello",
				metadata: { fixture: "ordered" },
			},
		);
		expect(response.status).toBe(206);
		expect(response.headers.get("x-kimi-trace")).toBe("trace-1");
		const events = parseResponseEvents(await response.text());
		expect(events.map((event) => event.type)).toEqual([
			"response.created",
			"response.in_progress",
			"response.output_item.added",
			"response.reasoning_summary_text.delta",
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.reasoning_summary_text.delta",
			"response.output_text.delta",
			"response.reasoning_summary_text.done",
			"response.output_item.done",
			"response.output_text.done",
			"response.content_part.done",
			"response.output_item.done",
			"response.completed",
		]);
		const terminal = events.at(-1) as {
			response: {
				output: JsonRecord[];
				usage: JsonRecord;
				metadata: JsonRecord;
			};
		};
		expect(terminal.response.output).toEqual([
			expect.objectContaining({
				type: "reasoning",
				summary: [
					{ type: "summary_text", text: "first thought second thought" },
				],
			}),
			expect.objectContaining({
				type: "message",
				content: [
					expect.objectContaining({ text: "first answer second answer" }),
				],
			}),
		]);
		expect(terminal.response.usage).toEqual({
			input_tokens: 7,
			output_tokens: 5,
			total_tokens: 12,
		});
		expect(terminal.response.metadata).toEqual({ fixture: "ordered" });
	});

	it("reconstructs fragmented interleaved ordinary, namespace, and custom tools", async () => {
		const chunks: JsonRecord[] = [
			{
				id: "chatcmpl_tools",
				model: "k3",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 2,
									id: "call_",
									function: { name: "pa", arguments: '{"in' },
								},
								{
									index: 0,
									id: "call_read",
									function: { name: "re", arguments: '{"path"' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 1,
									id: "call_spawn",
									function: { name: "agents.", arguments: '{"task":' },
								},
								{
									index: 0,
									function: { name: "ad", arguments: ':"a"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 2,
									id: "patch",
									function: { name: "tch", arguments: 'put":"diff"}' },
								},
								{
									index: 1,
									function: { name: "spawn", arguments: '"test"}' },
								},
							],
						},
						finish_reason: "tool_calls",
						usage: {
							prompt_tokens: 9,
							completion_tokens: 4,
							total_tokens: 13,
						},
					},
				],
			},
		];
		const response = await transformKimiChatResponseToOpenAIResponses(
			new Response(kimiSse(...chunks, "[DONE]"), {
				headers: { "content-type": "text/event-stream" },
			}),
			{
				model: "kimi/k3",
				stream: true,
				tools: [
					{ type: "function", name: "read", parameters: {} },
					{
						type: "namespace",
						name: "agents.",
						tools: [{ type: "function", name: "spawn", parameters: {} }],
					},
					{ type: "custom", name: "patch" },
				],
			},
		);
		const events = parseResponseEvents(await response.text());
		const terminal = events.at(-1) as {
			type: string;
			response: { output: JsonRecord[]; usage: JsonRecord };
		};
		expect(terminal.type).toBe("response.completed");
		expect(terminal.response.output).toEqual([
			expect.objectContaining({
				type: "function_call",
				call_id: "call_read",
				name: "read",
				arguments: '{"path":"a"}',
			}),
			expect.objectContaining({
				type: "function_call",
				call_id: "call_spawn",
				name: "spawn",
				namespace: "agents.",
				arguments: '{"task":"test"}',
			}),
			expect.objectContaining({
				type: "custom_tool_call",
				call_id: "call_patch",
				name: "patch",
				input: "diff",
			}),
		]);
		expect(terminal.response.usage).toEqual({
			input_tokens: 9,
			output_tokens: 4,
			total_tokens: 13,
		});
		const added = events.filter(
			(event) => event.type === "response.output_item.added",
		);
		expect(added.map((event) => event.output_index)).toEqual([0, 1, 2]);
	});

	it.each([
		["done", "stop", true, "response.completed"],
		["eof", "stop", false, "response.completed"],
		["length", "length", true, "response.incomplete"],
	] as const)("handles %s terminal streams", async (_name, finishReason, includeDone, expectedType) => {
		const payloads: Array<JsonRecord | "[DONE]"> = [
			{
				id: "chatcmpl_terminal",
				model: "k3",
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: finishReason,
					},
				],
			},
		];
		if (includeDone) payloads.push("[DONE]");
		const response = await transformKimiChatResponseToOpenAIResponses(
			new Response(kimiSse(...payloads), {
				headers: { "content-type": "text/event-stream" },
			}),
			{ model: "kimi/k3", stream: true },
		);
		const events = parseResponseEvents(await response.text());
		expect(events.at(-1)?.type).toBe(expectedType);
	});

	it.each([
		["malformed JSON", "data: {bad json\n\n"],
		[
			"unterminated EOF",
			kimiSse({
				id: "chatcmpl_partial",
				choices: [{ index: 0, delta: { content: "partial" } }],
			}),
		],
		[
			"trailing truncated frame after a finish",
			`${kimiSse({
				id: "chatcmpl_trailing",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}data: {"truncated"`,
		],
		["premature done", kimiSse("[DONE]")],
	] as const)("fails %s streams", async (_name, body) => {
		const response = await transformKimiChatResponseToOpenAIResponses(
			new Response(body, {
				headers: { "content-type": "text/event-stream" },
			}),
			{ model: "kimi/k3", stream: true },
		);
		const events = parseResponseEvents(await response.text());
		expect(events.at(-1)?.type).toBe("response.failed");
		expect(events.some((event) => event.type === "response.completed")).toBe(
			false,
		);
	});

	it.each([
		[
			"arguments",
			{ id: "call_bad", function: { name: "read", arguments: { path: "a" } } },
			"Kimi tool-call arguments fragment must be a string",
		],
		[
			"name",
			{ id: "call_bad", function: { name: false, arguments: "{}" } },
			"Kimi tool-call name fragment must be a string",
		],
		[
			"id",
			{ id: 42, function: { name: "read", arguments: "{}" } },
			"Kimi tool-call id fragment must be a string",
		],
	] as const)("fails closed for a non-string tool-call %s fragment", async (_field, malformedTool, expectedMessage) => {
		const response = await transformKimiChatResponseToOpenAIResponses(
			new Response(
				kimiSse(
					{
						id: "chatcmpl_malformed_tool",
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [{ index: 0, ...malformedTool }],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								index: 0,
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
					"[DONE]",
				),
				{ headers: { "content-type": "text/event-stream" } },
			),
			{ model: "kimi/k3", stream: true },
		);
		const events = parseResponseEvents(await response.text());
		expect(events.at(-1)).toEqual(
			expect.objectContaining({
				type: "response.failed",
				response: expect.objectContaining({
					error: expect.objectContaining({ message: expectedMessage }),
				}),
			}),
		);
		expect(events.some((event) => event.type === "response.completed")).toBe(
			false,
		);
	});

	it("accepts an omitted tool argument fragment before later string arguments", async () => {
		const response = await transformKimiChatResponseToOpenAIResponses(
			new Response(
				kimiSse(
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_read",
											function: { name: "read" },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											function: { arguments: '{"path":"a"}' },
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
					},
					"[DONE]",
				),
				{ headers: { "content-type": "text/event-stream" } },
			),
			{ model: "kimi/k3", stream: true },
		);
		const events = parseResponseEvents(await response.text());
		const terminal = events.at(-1) as {
			type: string;
			response: { output: JsonRecord[] };
		};
		expect(terminal.type).toBe("response.completed");
		expect(terminal.response.output).toEqual([
			expect.objectContaining({
				call_id: "call_read",
				name: "read",
				arguments: '{"path":"a"}',
			}),
		]);
	});

	it("fails a stream that exceeds the bounded tool-call count", async () => {
		const toolCalls = Array.from({ length: 129 }, (_, index) => ({
			index,
			id: `call_${index}`,
			function: { name: "read", arguments: "{}" },
		}));
		const response = await transformKimiChatResponseToOpenAIResponses(
			new Response(
				kimiSse({
					choices: [
						{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null },
					],
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
			{ model: "kimi/k3", stream: true },
		);
		const events = parseResponseEvents(await response.text());
		expect(events.at(-1)).toEqual(
			expect.objectContaining({
				type: "response.failed",
				response: expect.objectContaining({
					error: expect.objectContaining({
						message: "Kimi stream exceeded 128 tool calls",
					}),
				}),
			}),
		);
	});
});
