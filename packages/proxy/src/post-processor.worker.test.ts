import { afterEach, describe, expect, it } from "bun:test";
import { resetPricingCatalogue } from "@ccflare/core";
import {
	createRequestState,
	finalizeUsageMetrics,
	processBufferedResponseBody,
	processStreamChunk,
} from "./post-processor.worker";
import type { StartMessage } from "./worker-messages";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetPricingCatalogue();
});

function createStartMessage(): StartMessage {
	return {
		type: "start",
		requestId: "req-1",
		accountId: "account-1",
		accountName: "Primary account",
		method: "POST",
		path: "/v1/openai/responses",
		upstreamPath: "/responses",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		responseStatus: 200,
		responseHeaders: {
			"content-type": "text/event-stream; charset=utf-8",
		},
		isStream: true,
		providerName: "openai",
		retryAttempt: 0,
		failoverAttempts: 0,
	};
}

describe("processStreamChunk", () => {
	it("extracts usage when response.completed event and data are in the same chunk", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.completed",
					'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 13,
			outputTokens: 5,
			totalTokens: 18,
		});
	});

	it("extracts usage when response.completed event and data are split across chunks", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode("event: response.completed\n"),
			state,
		);
		processStreamChunk(
			new TextEncoder().encode(
				'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}\n\n',
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 13,
			outputTokens: 5,
			totalTokens: 18,
		});
	});

	it("adjusts cached input tokens and stores reasoning tokens from response.completed usage", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.completed",
					'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":18815,"output_tokens":431,"total_tokens":19246,"input_tokens_details":{"cached_tokens":18688},"output_tokens_details":{"reasoning_tokens":321}}}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 127,
			cacheReadInputTokens: 18688,
			outputTokens: 431,
			reasoningTokens: 321,
			totalTokens: 19246,
		});
	});

	it("tracks token timing and local token counts for response.output_text.delta events", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.output_text.delta",
					'data: {"type":"response.output_text.delta","delta":"Hello"}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.firstTokenTimestamp).toBeNumber();
		expect(state.lastTokenTimestamp).toBeNumber();
		expect((state.usage.outputTokensComputed ?? 0) > 0).toBe(true);
	});

	it("normalizes compatibility-prefixed models in chat completion chunks", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: message",
					'data: {"object":"chat.completion.chunk","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"}}]}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage.model).toBe("gpt-4o");
	});

	it("extracts usage from chat completion chunks without explicit event lines", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					'data: {"object":"chat.completion.chunk","model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"Hey"}}]}',
					"",
					'data: {"object":"chat.completion.chunk","model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":68,"input_tokens":44,"output_tokens":24,"cache_read_input_tokens":0,"reasoning_tokens":0}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-5.4",
			inputTokens: 44,
			outputTokens: 24,
			totalTokens: 68,
		});
		expect(state.firstTokenTimestamp).toBeNumber();
		expect(state.lastTokenTimestamp).toBeNumber();
	});

	it("estimates cost from a buffered headerless Codex SSE response", async () => {
		resetPricingCatalogue();
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						openai: {
							models: {
								"gpt-5.6-sol": {
									id: "gpt-5.6-sol",
									name: "GPT-5.6 Sol",
									cost: { input: 2, output: 8, cache_read: 0.2 },
								},
							},
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		const state = createRequestState({
			...createStartMessage(),
			providerName: "codex",
			responseHeaders: {},
			isStream: false,
		});
		const responseBody = Buffer.from(
			[
				"event: response.completed",
				'data: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":{"input_tokens":1000,"output_tokens":100,"total_tokens":1100,"input_tokens_details":{"cached_tokens":800}}}}',
				"",
			].join("\n"),
		).toString("base64");

		processBufferedResponseBody(responseBody, state);
		await finalizeUsageMetrics(state);

		expect(state.usage).toMatchObject({
			model: "gpt-5.6-sol",
			inputTokens: 200,
			cacheReadInputTokens: 800,
			outputTokens: 100,
			totalTokens: 1100,
		});
		expect(state.usage.costUsd).toBeCloseTo(
			(200 * 2 + 800 * 0.2 + 100 * 8) / 1_000_000,
			10,
		);
		expect(state.firstTokenTimestamp).toBeUndefined();
		expect(state.lastTokenTimestamp).toBeUndefined();
	});
});
