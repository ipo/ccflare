import { describe, expect, it } from "bun:test";
import {
	createApiKeyAccount,
	expectBuildUrlCases,
	expectNoOAuthSupport,
	expectRemovedHeaders,
	expectUnifiedRateLimit,
} from "../../test-helpers";
import { OpenAIProvider } from "./provider";

describe("OpenAIProvider", () => {
	const provider = new OpenAIProvider();

	it("builds upstream URLs from the stripped OpenAI path", () => {
		expectBuildUrlCases(provider, [
			{
				upstreamPath: "/responses",
				expected: "https://api.openai.com/v1/responses",
			},
			{
				upstreamPath: "/models",
				query: "?foo=bar",
				expected: "https://api.openai.com/v1/models?foo=bar",
			},
			{
				upstreamPath: "/chat/completions",
				account: createApiKeyAccount("openai", {
					base_url: "https://openai.internal/v1/",
				}),
				expected: "https://openai.internal/v1/chat/completions",
			},
		]);
	});

	it("injects Authorization from API key accounts", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
				"anthropic-version": "2023-06-01",
				"x-ccflare-session-id": "session-xyz",
			}),
			createApiKeyAccount("openai"),
		);

		expect(headers.get("authorization")).toBe("Bearer sk-openai-test");
		expectRemovedHeaders(headers, [
			"host",
			"anthropic-version",
			"x-ccflare-session-id",
		]);
	});

	it("ignores OAuth access tokens and does not expose OAuth helpers", () => {
		const headers = provider.prepareHeaders(
			new Headers({ host: "localhost:8080" }),
			createApiKeyAccount("openai", {
				auth_method: "oauth",
				api_key: null,
				access_token: "openai-access-token",
				refresh_token: "openai-refresh-token",
				expires_at: Date.now() + 60_000,
			}),
		);

		expect(headers.get("authorization")).toBeNull();
		expectRemovedHeaders(headers, ["host", "x-api-key"]);
		expectNoOAuthSupport(provider);
	});

	it("parses OpenAI x-ratelimit headers", () => {
		const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"x-ratelimit-limit-requests": "100",
				"x-ratelimit-remaining-requests": "17",
				"x-ratelimit-reset-requests": String(resetSeconds),
			},
		});

		expectUnifiedRateLimit(provider, response, {
			isRateLimited: false,
			resetTime: resetSeconds * 1000,
			statusHeader: "allowed",
			remaining: 17,
		});
	});

	it("parses Codex rate limit headers", () => {
		const fiveHourReset = Math.floor((Date.now() + 60_000) / 1000);
		const sevenDayReset = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"x-codex-primary-used-percent": "12",
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-at": String(sevenDayReset),
				"x-codex-secondary-used-percent": "4",
				"x-codex-secondary-window-minutes": "300",
				"x-codex-secondary-reset-at": String(fiveHourReset),
			},
		});

		expectUnifiedRateLimit(provider, response, {
			isRateLimited: false,
			resetTime: fiveHourReset * 1000,
			statusHeader: "allowed",
			remaining: undefined,
		});
	});

	it("extracts usage from non-streaming JSON responses", async () => {
		const response = new Response(
			JSON.stringify({
				id: "chatcmpl_test",
				model: "gpt-4o-mini",
				usage: {
					prompt_tokens: 11,
					completion_tokens: 7,
					total_tokens: 18,
				},
			}),
			{
				headers: {
					"content-type": "application/json",
				},
			},
		);

		await expect(provider.extractUsageInfo(response)).resolves.toEqual({
			model: "gpt-4o-mini",
			promptTokens: 11,
			completionTokens: 7,
			totalTokens: 18,
			inputTokens: 11,
			outputTokens: 7,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});

	it("extracts usage from response.completed SSE events", async () => {
		const response = new Response(
			[
				"event: response.created",
				'data: {"response":{"id":"resp_123","model":"gpt-4o"}}',
				"",
				"event: response.completed",
				'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}',
				"",
			].join("\n"),
			{
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
				},
			},
		);

		await expect(provider.extractUsageInfo(response)).resolves.toEqual({
			model: "gpt-4o",
			promptTokens: 13,
			completionTokens: 5,
			totalTokens: 18,
			inputTokens: 13,
			outputTokens: 5,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});

	it("detects streaming responses from the content type", () => {
		expect(
			provider.isStreamingResponse?.(
				new Response("", {
					headers: {
						"content-type": "text/event-stream; charset=utf-8",
					},
				}),
			),
		).toBe(true);
		expect(
			provider.isStreamingResponse?.(
				new Response("", {
					headers: {
						"content-type": "application/json",
					},
				}),
			),
		).toBe(false);
	});
});
