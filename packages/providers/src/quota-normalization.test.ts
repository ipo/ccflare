import { describe, expect, test } from "bun:test";
import type { AccountProvider } from "@ccflare/types";
import { normalizeQuotaWindows } from "./quota-normalization";
import type { ProviderQuotaReport } from "./types";

function report(data: unknown): ProviderQuotaReport {
	return {
		state: "ok",
		collectedAt: "2026-08-04T00:00:00.000Z",
		windows: [],
		sources: {
			usage: { state: "ok", status: 200, data },
		},
	};
}

describe("normalizeQuotaWindows", () => {
	test("normalizes Claude Code account and model windows", () => {
		const raw = {
			five_hour: {
				utilization: "25",
				resets_at: "2026-08-04T05:00:00Z",
			},
			seven_day: { utilization: 40 },
			seven_day_opus: null,
			seven_day_sonnet: {
				utilization: 75.5,
				reset_at: 1_775_603_600,
			},
			additive_future_field: { utilization: 99 },
		};

		expect(normalizeQuotaWindows("claude-code", report(raw))).toEqual([
			{
				id: "claude-code:account:5h",
				label: "5-hour limit",
				period: "5h",
				scope: "account",
				usedPercent: 25,
				resetAt: "2026-08-04T05:00:00.000Z",
			},
			{
				id: "claude-code:account:7d",
				label: "Weekly limit",
				period: "7d",
				scope: "account",
				usedPercent: 40,
			},
			{
				id: "claude-code:model:sonnet:7d",
				label: "Sonnet weekly limit",
				period: "7d",
				scope: "model",
				usedPercent: 75.5,
				resetAt: "2026-04-07T23:13:20.000Z",
				model: "sonnet",
			},
		]);
	});

	test("accepts Claude Code camel-case variants and ignores malformed siblings", () => {
		expect(
			normalizeQuotaWindows(
				"claude-code",
				report({
					fiveHour: { utilization: Number.NaN },
					sevenDay: { utilization: 12 },
					sevenDayOpus: { utilization: "not-a-number" },
				}),
			),
		).toEqual([
			{
				id: "claude-code:account:7d",
				label: "Weekly limit",
				period: "7d",
				scope: "account",
				usedPercent: 12,
			},
		]);
	});

	test("normalizes Codex primary, secondary, meter, and model variants", () => {
		const result = normalizeQuotaWindows(
			"codex",
			report({
				data: {
					rate_limit: {
						primary_window: {
							used_percent: 11,
							reset_at: 1_775_606_400,
						},
						secondary_window: {
							used: 2,
							limit: 10,
							reset_after_seconds: 3600,
						},
					},
					additional_rate_limits: [
						{
							limit_name: "codex_bengalfox",
							rate_limit: {
								primary_window: { used_percent: 35 },
								secondary_window: { used_percent: "bad" },
							},
						},
						{
							modelName: "gpt-special",
							rateLimit: {
								primaryWindow: { usedPercent: "50" },
								secondaryWindow: { used: 3, limit: 4 },
							},
						},
						null,
					],
				},
			}),
		);

		expect(result).toEqual([
			{
				id: "codex:account:main:5h",
				label: "5-hour limit",
				period: "5h",
				scope: "account",
				usedPercent: 11,
				resetAt: "2026-04-08T00:00:00.000Z",
			},
			{
				id: "codex:account:main:7d",
				label: "Weekly limit",
				period: "7d",
				scope: "account",
				usedPercent: 20,
				used: 2,
				limit: 10,
				resetAt: "2026-08-04T01:00:00.000Z",
			},
			{
				id: "codex:meter:codex-bengalfox:5h",
				label: "Codex Bengalfox 5-hour limit",
				period: "5h",
				scope: "meter",
				usedPercent: 35,
			},
			{
				id: "codex:model:gpt-special:5h",
				label: "Gpt Special 5-hour limit",
				period: "5h",
				scope: "model",
				usedPercent: 50,
				model: "gpt-special",
			},
			{
				id: "codex:model:gpt-special:7d",
				label: "Gpt Special weekly limit",
				period: "7d",
				scope: "model",
				usedPercent: 75,
				used: 3,
				limit: 4,
				model: "gpt-special",
			},
		]);
	});

	test("accepts object-mapped Codex meters", () => {
		const result = normalizeQuotaWindows(
			"codex",
			report({
				rateLimit: { fiveHour: { usedPercent: 8 } },
				additionalRateLimits: {
					future_meter: {
						rateLimit: { sevenDay: { used: "9", limit: "10" } },
					},
				},
			}),
		);

		expect(result.map(({ id, usedPercent }) => ({ id, usedPercent }))).toEqual([
			{ id: "codex:account:main:5h", usedPercent: 8 },
			{ id: "codex:meter:future-meter:7d", usedPercent: 90 },
		]);
	});

	test("normalizes Kimi weekly, 5-hour, model, and meter windows", () => {
		const result = normalizeQuotaWindows(
			"kimi",
			report({
				usage: {
					name: "Weekly limit",
					used: "40",
					limit: "1000",
				},
				limits: [
					{
						detail: { name: "5h limit", used: 1, limit: 100 },
						window: { end_time: "2026-08-04T05:00:00Z" },
					},
					{ detail: { name: "broken", used: "oops", limit: 10 } },
					{
						detail: {
							name: "K3 weekly",
							model: "k3",
							used_percent: 65,
						},
					},
					{
						detail: {
							name: "High-speed 5 hour quota",
							meter_name: "high_speed",
							used: 4,
							limit: 5,
						},
					},
				],
			}),
		);

		expect(result).toEqual([
			{
				id: "kimi:account:summary:7d",
				label: "Weekly limit",
				period: "7d",
				scope: "account",
				usedPercent: 4,
				used: 40,
				limit: 1000,
			},
			{
				id: "kimi:account:5h-limit:5h",
				label: "5h limit",
				period: "5h",
				scope: "account",
				usedPercent: 1,
				used: 1,
				limit: 100,
				resetAt: "2026-08-04T05:00:00.000Z",
			},
			{
				id: "kimi:model:k3:7d",
				label: "K3 weekly",
				period: "7d",
				scope: "model",
				usedPercent: 65,
				model: "k3",
			},
			{
				id: "kimi:meter:high-speed:5h",
				label: "High-speed 5 hour quota",
				period: "5h",
				scope: "meter",
				usedPercent: 80,
				used: 4,
				limit: 5,
			},
		]);
	});

	test("uses object-mapped Kimi windows and descriptive unknown periods", () => {
		const result = normalizeQuotaWindows(
			"kimi",
			report({
				limits: {
					monthly: { detail: { used: 1, limit: 2 } },
					invalid: null,
				},
			}),
		);
		expect(result).toEqual([
			{
				id: "kimi:account:monthly:monthly",
				label: "monthly",
				period: "monthly",
				scope: "account",
				usedPercent: 50,
				used: 1,
				limit: 2,
			},
		]);
	});

	test("returns no windows for failed, malformed, or unsupported reports", () => {
		const failed = report({ five_hour: { utilization: 10 } });
		failed.sources.usage = { state: "failed", status: 503 };
		expect(normalizeQuotaWindows("claude-code", failed)).toEqual([]);
		expect(normalizeQuotaWindows("codex", report(null))).toEqual([]);
		expect(
			normalizeQuotaWindows("anthropic" as AccountProvider, report({})),
		).toEqual([]);
	});

	test("ignores out-of-range relative reset values without dropping the window", () => {
		expect(
			normalizeQuotaWindows(
				"codex",
				report({
					rate_limit: {
						primary_window: {
							used_percent: 10,
							reset_after_seconds: 1e20,
						},
					},
				}),
			),
		).toEqual([
			{
				id: "codex:account:main:5h",
				label: "5-hour limit",
				period: "5h",
				scope: "account",
				usedPercent: 10,
			},
		]);
	});

	test("does not mutate the raw report", () => {
		const input = report({
			usage: { used: 5, limit: 10 },
			limits: [{ detail: { name: "5h limit", used: 1, limit: 2 } }],
		});
		const before = structuredClone(input);
		normalizeQuotaWindows("kimi", input);
		expect(input).toEqual(before);
	});
});
