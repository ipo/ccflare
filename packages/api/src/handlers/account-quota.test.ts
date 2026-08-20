import { describe, expect, test } from "bun:test";
import type { ProviderQuotaReport } from "@ccflare/providers";
import { quotaIndicatesAvailability } from "./account-quota";

function report(data: unknown, state: "ok" | "partial" | "failed" = "ok") {
	return {
		state,
		collectedAt: new Date().toISOString(),
		windows: [],
		sources: {
			usage: { state: "ok" as const, status: 200, data },
		},
	} as ProviderQuotaReport;
}

describe("quotaIndicatesAvailability", () => {
	test("codex: allowed and not limited => available", () => {
		expect(
			quotaIndicatesAvailability(
				"codex",
				report({ rate_limit: { allowed: true, limit_reached: false } }),
			),
		).toBe(true);
	});

	test("codex: limit_reached => not available", () => {
		expect(
			quotaIndicatesAvailability(
				"codex",
				report({ rate_limit: { allowed: false, limit_reached: true } }),
			),
		).toBe(false);
	});

	test("codex: accepts the root-level availability used by the quota API", () => {
		expect(
			quotaIndicatesAvailability(
				"codex",
				report({
					allowed: true,
					rate_limit: { primary_window: { used_percent: 10 } },
				}),
			),
		).toBe(true);
	});

	test("claude-code: all reported windows < 100% => available", () => {
		expect(
			quotaIndicatesAvailability(
				"claude-code",
				report({
					five_hour: { utilization: 0 },
					seven_day: { utilization: 12 },
					seven_day_opus: null,
				}),
			),
		).toBe(true);
	});

	test("claude-code: any window at 100% => not available", () => {
		expect(
			quotaIndicatesAvailability(
				"claude-code",
				report({
					five_hour: { utilization: 100 },
					seven_day: { utilization: 12 },
				}),
			),
		).toBe(false);
	});

	test("kimi: summary and window headroom => available", () => {
		expect(
			quotaIndicatesAvailability(
				"kimi",
				report({
					usage: { limit: "100", used: "5" },
					limits: [{ detail: { limit: "100", used: "1" } }],
				}),
			),
		).toBe(true);
	});

	test("kimi: exhausted weekly summary => not available", () => {
		expect(
			quotaIndicatesAvailability(
				"kimi",
				report({ usage: { limit: "100", used: "100" }, limits: [] }),
			),
		).toBe(false);
	});

	test("kimi: exhausted window detail => not available", () => {
		expect(
			quotaIndicatesAvailability(
				"kimi",
				report({
					usage: { limit: "100", used: "5" },
					limits: [{ detail: { limit: "100", used: "100" } }],
				}),
			),
		).toBe(false);
	});

	test("grok: provider-normalized credit windows => available", () => {
		const grokReport: ProviderQuotaReport = {
			state: "ok",
			collectedAt: new Date().toISOString(),
			windows: [
				{
					id: "grok:included",
					label: "Included credits",
					period: "weekly",
					scope: "account",
					usedPercent: 20,
				},
			],
			sources: {
				credits: { state: "ok", status: 200, data: {} },
			},
		};
		expect(quotaIndicatesAvailability("grok", grokReport)).toBe(true);
		expect(
			quotaIndicatesAvailability("grok", {
				...grokReport,
				windows: [{ ...grokReport.windows[0], usedPercent: 100 }],
			}),
		).toBe(false);
		expect(
			quotaIndicatesAvailability("grok", {
				...grokReport,
				windows: [
					{ ...grokReport.windows[0], usedPercent: 100 },
					{
						...grokReport.windows[0],
						id: "grok:on-demand",
						usedPercent: 20,
					},
				],
				sources: {
					credits: {
						state: "ok",
						status: 200,
						data: { onDemandEnabled: true },
					},
				},
			}),
		).toBe(true);
		expect(
			quotaIndicatesAvailability("grok", {
				...grokReport,
				windows: [
					{
						...grokReport.windows[0],
						id: "grok:on-demand",
						usedPercent: 20,
					},
				],
			}),
		).toBe(false);
		expect(
			quotaIndicatesAvailability("grok", {
				...grokReport,
				state: "failed",
				windows: [],
			}),
		).toBe(false);
	});

	test("garbage / failed / unparsable payloads => false (fail-safe)", () => {
		expect(quotaIndicatesAvailability("codex", report(null))).toBe(false);
		expect(quotaIndicatesAvailability("codex", report({}, "failed"))).toBe(
			false,
		);
		expect(
			quotaIndicatesAvailability("claude-code", report({ seven_day: {} })),
		).toBe(false);
		expect(quotaIndicatesAvailability("kimi", report({ usage: {} }))).toBe(
			false,
		);
		expect(
			quotaIndicatesAvailability(
				"kimi",
				report({ usage: { limit: "abc", used: "5" } }),
			),
		).toBe(false);
	});
});
