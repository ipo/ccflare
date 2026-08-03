import { describe, expect, it } from "bun:test";
import {
	applyClaudeCodeShaping,
	convertAnthropicRequestToOpenAIChat,
	convertAnthropicRequestToOpenAIResponses,
	convertOpenAIChatRequestToAnthropic,
	convertOpenAIChatRequestToOpenAIResponses,
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
		expect(output).not.toHaveProperty("parallel_tool_calls");
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

	it("preserves the client parallel_tool_calls setting for Codex", () => {
		for (const parallelToolCalls of [false, true, undefined]) {
			const output = normalizeCodexResponsesRequest({
				model: "gpt-5.6-sol",
				...(parallelToolCalls === undefined
					? {}
					: { parallel_tool_calls: parallelToolCalls }),
			});

			if (parallelToolCalls === undefined) {
				expect(output).not.toHaveProperty("parallel_tool_calls");
			} else {
				expect(output.parallel_tool_calls).toBe(parallelToolCalls);
			}
		}
	});
});
