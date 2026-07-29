import { describe, expect, it } from "bun:test";
import {
	applyClaudeCodeShaping,
	convertAnthropicRequestToOpenAIChat,
	convertAnthropicRequestToOpenAIResponses,
	convertOpenAIChatRequestToAnthropic,
	convertOpenAIChatRequestToOpenAIResponses,
	convertOpenAIResponsesRequestToAnthropic,
	normalizeCodexResponsesRequest,
} from "./requests";

describe("compat request transforms", () => {
	it("preserves string-typed user content when applying Claude Code shaping", () => {
		const output = applyClaudeCodeShaping({
			system: "Follow the repo conventions.",
			messages: [{ role: "user", content: "Keep this request intact." }],
		});

		expect(output.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Follow the repo conventions." },
					{ type: "text", text: "Keep this request intact." },
				],
			},
		]);
	});

	it("keeps malformed tool_result payloads valid when converting anthropic to openai chat", () => {
		const output = convertAnthropicRequestToOpenAIChat(
			{
				model: "claude-sonnet-4",
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_abc",
								name: "Read",
								input: { file: "test.go" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_abc",
							},
							{
								type: "tool_result",
								tool_use_id: "call_abc",
								content: null,
							},
							{
								type: "tool_result",
								tool_use_id: "call_abc",
								content: [
									{ type: "text", text: "File content here" },
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "iVBORw0KGgoAAAANSUhEUg==",
										},
									},
								],
							},
						],
					},
				],
			},
			"claude-sonnet-4",
		);

		expect(output.messages).toEqual([
			expect.objectContaining({
				role: "assistant",
				tool_calls: [expect.objectContaining({ id: "call_abc" })],
			}),
			{
				role: "tool",
				tool_call_id: "call_abc",
				content: "",
			},
			{
				role: "tool",
				tool_call_id: "call_abc",
				content: "",
			},
			{
				role: "tool",
				tool_call_id: "call_abc",
				content: [
					{ type: "text", text: "File content here" },
					{
						type: "image_url",
						image_url: {
							url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
						},
					},
				],
			},
		]);
	});

	it("keeps malformed tool_result payloads valid when converting anthropic to openai responses", () => {
		const output = convertAnthropicRequestToOpenAIResponses(
			{
				model: "claude-sonnet-4",
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_abc",
								name: "Read",
								input: { file: "test.go" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_abc",
							},
							{
								type: "tool_result",
								tool_use_id: "call_abc",
								content: null,
							},
							{
								type: "tool_result",
								tool_use_id: "call_abc",
								content: [
									{ type: "text", text: "File content here" },
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "iVBORw0KGgoAAAANSUhEUg==",
										},
									},
								],
							},
						],
					},
				],
			},
			"claude-sonnet-4",
		);

		expect(output.input).toEqual([
			expect.objectContaining({
				type: "function_call",
				call_id: "call_abc",
			}),
			{
				type: "function_call_output",
				call_id: "call_abc",
				output: "",
			},
			{
				type: "function_call_output",
				call_id: "call_abc",
				output: "",
			},
			{
				type: "function_call_output",
				call_id: "call_abc",
				output: [
					{ type: "text", text: "File content here" },
					{
						type: "image_url",
						image_url: {
							url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
						},
					},
				],
			},
		]);
	});

	it("preserves multimodal anthropic tool_result payloads for openai chat compatibility", () => {
		const output = convertAnthropicRequestToOpenAIChat(
			{
				model: "claude-sonnet-4",
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_1",
								name: "Read",
								input: { file: "test.go" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_1",
								content: [
									{ type: "text", text: "tool ok" },
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "iVBORw0KGgoAAAANSUhEUg==",
										},
									},
								],
							},
						],
					},
				],
			},
			"claude-sonnet-4",
		);

		expect(output.messages).toEqual([
			expect.objectContaining({
				role: "assistant",
				tool_calls: [expect.objectContaining({ id: "call_1" })],
			}),
			{
				role: "tool",
				tool_call_id: "call_1",
				content: [
					{ type: "text", text: "tool ok" },
					{
						type: "image_url",
						image_url: {
							url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
						},
					},
				],
			},
		]);
	});

	it("preserves multimodal tool messages when converting openai chat to anthropic", () => {
		const output = convertOpenAIChatRequestToAnthropic(
			{
				model: "gpt-4.1",
				messages: [
					{
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: {
									name: "Read",
									arguments: '{"file":"test.go"}',
								},
							},
						],
					},
					{
						role: "tool",
						tool_call_id: "call_1",
						content: [
							{ type: "text", text: "tool ok" },
							{
								type: "image_url",
								image_url: {
									url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
								},
							},
						],
					},
				],
			},
			"claude-sonnet-4",
		);

		expect(output.messages).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "Read",
						input: { file: "test.go" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: [
							{ type: "text", text: "tool ok" },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "iVBORw0KGgoAAAANSUhEUg==",
								},
							},
						],
					},
				],
			},
		]);
	});

	it("keeps a fallback user turn for system-only openai chat requests", () => {
		const output = convertOpenAIChatRequestToAnthropic(
			{
				model: "gpt-4.1",
				messages: [{ role: "system", content: "You are terse." }],
			},
			"claude-sonnet-4",
		);

		expect(output.system).toEqual([{ type: "text", text: "You are terse." }]);
		expect(output.messages).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "" }],
			},
		]);
	});

	it("maps anthropic thinking budgets to openai reasoning effort", () => {
		const output = convertAnthropicRequestToOpenAIChat(
			{
				model: "claude-sonnet-4",
				thinking: { type: "enabled", budget_tokens: 8192 },
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			},
			"claude-sonnet-4",
		);

		expect(output.reasoning_effort).toBe("medium");
	});

	it("maps openai reasoning effort to anthropic adaptive thinking for claude 4.6", () => {
		const output = convertOpenAIChatRequestToAnthropic(
			{
				model: "gpt-5.4",
				reasoning_effort: "xhigh",
				messages: [{ role: "user", content: "hi" }],
			},
			"claude-opus-4-6",
		);

		expect(output.thinking).toEqual({ type: "adaptive" });
		expect(output.output_config).toEqual({ effort: "max" });
	});

	it.each([
		"claude-fable-5",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-sonnet-5",
	])("maps maximum effort to adaptive thinking for %s", (model) => {
		const output = convertOpenAIResponsesRequestToAnthropic(
			{
				input: "hi",
				reasoning: { effort: "xhigh" },
			},
			model,
		);

		expect(output.thinking).toEqual({ type: "adaptive" });
		expect(output.output_config).toEqual({ effort: "max" });
	});

	it("keeps claude haiku 4.5 on legacy budget thinking", () => {
		const output = convertOpenAIResponsesRequestToAnthropic(
			{
				input: "hi",
				reasoning: { effort: "xhigh" },
			},
			"claude-haiku-4-5",
		);

		expect(output.thinking).toEqual({
			type: "enabled",
			budget_tokens: 32768,
		});
		expect(output.output_config).toBeUndefined();
	});

	it("projects responses tools from top-level and additional_tools declarations", () => {
		const stringSchema = {
			type: "object",
			properties: { q: { type: "string" } },
		};
		const output = convertOpenAIResponsesRequestToAnthropic(
			{
				input: [
					{
						type: "additional_tools",
						role: "developer",
						tools: [
							{
								type: "function",
								name: "additional_function",
								description: "Additional ordinary",
								parameters: stringSchema,
							},
							{
								type: "namespace",
								name: "agents.",
								description: "Agent tools",
								tools: [
									{
										type: "function",
										name: "spawn",
										description: "Spawn an agent",
										parameters: { type: "object", required: ["task"] },
									},
								],
							},
							{
								type: "custom",
								name: "additional_patch",
								description: "Additional patch",
							},
						],
					},
					{ type: "message", role: "user", content: "fix it" },
				],
				tools: [
					{
						type: "function",
						name: "top_function",
						description: "Top ordinary",
						parameters: stringSchema,
					},
					{
						type: "namespace",
						name: "mcp__repo__",
						tools: [
							{
								type: "function",
								name: "read",
								description: "Read repo",
								parameters: { type: "object", required: ["path"] },
							},
						],
					},
					{
						type: "custom",
						name: "apply_patch",
						description: "Apply patch",
					},
				],
				tool_choice: { type: "function", namespace: "agents.", name: "spawn" },
			},
			"claude-sonnet-5",
		);

		expect(output.tools).toEqual([
			{
				name: "top_function",
				description: "Top ordinary",
				input_schema: stringSchema,
			},
			{
				name: "mcp__repo__read",
				description: "Read repo",
				input_schema: { type: "object", required: ["path"] },
			},
			{
				name: "apply_patch",
				description: "Apply patch",
				input_schema: {
					type: "object",
					properties: { input: { type: "string" } },
					required: ["input"],
					additionalProperties: false,
				},
			},
			{
				name: "additional_function",
				description: "Additional ordinary",
				input_schema: stringSchema,
			},
			{
				name: "agents.spawn",
				description: "Spawn an agent",
				input_schema: { type: "object", required: ["task"] },
			},
			{
				name: "additional_patch",
				description: "Additional patch",
				input_schema: {
					type: "object",
					properties: { input: { type: "string" } },
					required: ["input"],
					additionalProperties: false,
				},
			},
		]);
		expect(output.tool_choice).toEqual({ type: "tool", name: "agents.spawn" });
		expect(output.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "fix it" }] },
		]);
	});

	it("maps custom Responses tool choice through the projected wire name", () => {
		const output = convertOpenAIResponsesRequestToAnthropic(
			{
				input: "fix it",
				tools: [{ type: "custom", name: "apply_patch" }],
				tool_choice: { type: "custom", name: "apply_patch" },
			},
			"claude-sonnet-5",
		);

		expect(output.tool_choice).toEqual({
			type: "tool",
			name: "apply_patch",
		});
	});

	it("preserves Responses tool_choice none while tools remain declared", () => {
		const output = convertOpenAIResponsesRequestToAnthropic(
			{
				input: "do not use tools",
				tools: [
					{
						type: "function",
						name: "read",
						parameters: { type: "object" },
					},
				],
				tool_choice: "none",
			},
			"claude-sonnet-5",
		);

		expect(output.tools).toEqual([
			{
				name: "read",
				description: "",
				input_schema: { type: "object" },
			},
		]);
		expect(output.tool_choice).toEqual({ type: "none" });
	});

	it("raises anthropic max_tokens when converted thinking budgets would be invalid", () => {
		const output = convertOpenAIChatRequestToAnthropic(
			{
				model: "gpt-5.4",
				max_tokens: 128,
				reasoning_effort: "medium",
				messages: [{ role: "user", content: "hi" }],
			},
			"claude-sonnet-4",
		);

		expect(output.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
		expect(output.max_tokens).toBe(8193);
	});

	it("maps chat response_format and built-in tool choices to responses format", () => {
		const output = convertOpenAIChatRequestToOpenAIResponses(
			{
				model: "gpt-5.4",
				messages: [{ role: "user", content: "hi" }],
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "answer",
						strict: true,
						schema: {
							type: "object",
							properties: { value: { type: "string" } },
							required: ["value"],
						},
					},
				},
				text: { verbosity: "low" },
				tools: [{ type: "web_search_preview" }],
				tool_choice: { type: "function", function: { name: "Read" } },
			},
			"gpt-5.4",
		);

		expect(output.text).toEqual({
			format: {
				type: "json_schema",
				name: "answer",
				strict: true,
				schema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
				},
			},
			verbosity: "low",
		});
		expect(output.tools).toEqual([{ type: "web_search_preview" }]);
		expect(output.tool_choice).toEqual({ type: "function", name: "Read" });
	});

	it("normalizes codex responses requests to codex-safe defaults", () => {
		const output = normalizeCodexResponsesRequest({
			model: "gpt-5.4",
			input: [{ type: "message", role: "system", content: [] }],
			tools: [{ type: "web_search_preview" }],
			tool_choice: { type: "web_search_preview_2025_03_11" },
			temperature: 0.2,
			top_p: 0.9,
			truncation: "disabled",
			user: "abc",
			service_tier: "default",
		});

		expect(output.stream).toBe(true);
		expect(output.store).toBe(false);
		expect(output.parallel_tool_calls).toBe(true);
		expect(output.include).toEqual(["reasoning.encrypted_content"]);
		expect(output.reasoning).toEqual({ effort: "medium", summary: "auto" });
		expect(output.temperature).toBeUndefined();
		expect(output.top_p).toBeUndefined();
		expect(output.truncation).toBeUndefined();
		expect(output.user).toBeUndefined();
		expect(output.service_tier).toBeUndefined();
		expect(output.tools).toEqual([{ type: "web_search" }]);
		expect(output.tool_choice).toEqual({ type: "web_search" });
		expect(output.input).toEqual([
			{ type: "message", role: "developer", content: [] },
		]);
	});
});
