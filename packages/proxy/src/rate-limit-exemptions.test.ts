import { describe, expect, it } from "bun:test";
import { isRateLimitExemptModel } from "./rate-limit-exemptions";

describe("isRateLimitExemptModel", () => {
	it("matches any *-codex-spark model on the codex provider", () => {
		expect(isRateLimitExemptModel("codex", "gpt-5.3-codex-spark")).toBe(true);
		expect(isRateLimitExemptModel("codex", "gpt-9.9-codex-spark")).toBe(true);
	});

	it("does not match main-meter codex models", () => {
		expect(isRateLimitExemptModel("codex", "gpt-5.5")).toBe(false);
		expect(isRateLimitExemptModel("codex", "gpt-5.6-sol")).toBe(false);
		expect(isRateLimitExemptModel("codex", "gpt-5.3-codex")).toBe(false);
		expect(isRateLimitExemptModel("codex", "gpt-5.3-codex-sparkline")).toBe(
			false,
		);
	});

	it("does not match spark-suffixed models on other providers", () => {
		expect(isRateLimitExemptModel("openai", "gpt-5.3-codex-spark")).toBe(false);
		expect(isRateLimitExemptModel("claude-code", "gpt-5.3-codex-spark")).toBe(
			false,
		);
	});

	it("treats a missing model as not exempt", () => {
		expect(isRateLimitExemptModel("codex", undefined)).toBe(false);
	});
});
