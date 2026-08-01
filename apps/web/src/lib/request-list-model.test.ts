import { describe, expect, it } from "bun:test";
import type { RequestSummary } from "@ccflare/types";
import {
	applyRequestStreamEvent,
	filterRequestList,
	reconcileRequestList,
} from "./request-list-model";

function summary(
	id: string,
	overrides: Partial<RequestSummary> = {},
): RequestSummary {
	return {
		id,
		timestamp: new Date(1_000).toISOString(),
		method: "POST",
		path: "/v1/openai/responses",
		provider: "openai",
		upstreamPath: "/responses",
		accountUsed: "account-1",
		accountName: "Primary",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 20,
		failoverAttempts: 0,
		model: "gpt-test",
		promptTokens: 10,
		completionTokens: 5,
		totalTokens: 15,
		inputTokens: 10,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 5,
		reasoningTokens: 0,
		costUsd: 0.01,
		tokensPerSecond: 2,
		ttftMs: 4,
		proxyOverheadMs: 1,
		upstreamTtfbMs: 3,
		streamingDurationMs: 10,
		responseId: null,
		previousResponseId: null,
		responseChainId: null,
		clientSessionId: "session-1",
		...overrides,
	};
}

describe("request list model", () => {
	it("reconciles summaries within the limit while preserving live pending rows", () => {
		const pending = applyRequestStreamEvent(
			[],
			{
				type: "ingress",
				id: "pending",
				timestamp: 2_000,
				method: "POST",
				path: "/pending",
				clientSessionId: "session-pending",
			},
			200,
		);
		const reconciled = reconcileRequestList(
			[summary("stored", { timestamp: new Date(1_500).toISOString() })],
			pending,
			2,
		);

		expect(reconciled.map((item) => item.id)).toEqual(["pending", "stored"]);
		expect(JSON.stringify(reconciled)).not.toContain('request":');
		expect(JSON.stringify(reconciled)).not.toContain('response":');
	});

	it("applies ingress, start, and summary events without payload fields", () => {
		let items = applyRequestStreamEvent(
			[],
			{
				type: "ingress",
				id: "live",
				timestamp: 1_000,
				method: "POST",
				path: "/live",
			},
			200,
		);
		items = applyRequestStreamEvent(
			items,
			{
				type: "start",
				id: "live",
				timestamp: 1_000,
				method: "POST",
				path: "/live",
				accountId: "account-2",
				accountName: "Secondary",
				statusCode: 202,
			},
			200,
		);
		expect(items[0]).toMatchObject({
			pending: true,
			accountName: "Secondary",
			statusCode: 202,
		});

		items = applyRequestStreamEvent(
			items,
			{ type: "summary", payload: summary("live", { success: false }) },
			200,
		);
		expect(items[0]).toMatchObject({
			pending: false,
			summary: { success: false },
		});
		expect(JSON.stringify(items)).not.toContain("headers");
		expect(JSON.stringify(items)).not.toContain("body");
	});

	it("preserves session, account, status, and date filtering", () => {
		const items = reconcileRequestList(
			[
				summary("match", { timestamp: "2026-08-01T12:00:00.000Z" }),
				summary("other", {
					timestamp: "2026-07-30T12:00:00.000Z",
					accountName: "Secondary",
					statusCode: 500,
					clientSessionId: "session-2",
				}),
			],
			[],
			200,
		);
		expect(
			filterRequestList(items, {
				sessionId: "session-1",
				account: "Primary",
				dateFrom: "2026-08-01",
				dateTo: "2026-08-01",
				statusCodes: new Set(["200"]),
			}).map((item) => item.id),
		).toEqual(["match"]);
	});
});
