import { describe, expect, it } from "bun:test";
import { sessionColor } from "./session-color";

const SAMPLES = [
	"019f9ff2-c788-785c-92ed-d38f9f716c84",
	"session-123",
	"a",
	"",
	"🚀-unicode-session",
	"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
	...Array.from({ length: 50 }, (_, i) => `session-${i}-${i * 7919}`),
];

function channels(hex: string): number[] {
	return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

describe("sessionColor", () => {
	it("is deterministic", () => {
		for (const sample of SAMPLES) {
			expect(sessionColor(sample)).toEqual(sessionColor(sample));
		}
	});

	it("keeps every channel in the light spectrum [0x99, 0xdf]", () => {
		for (const sample of SAMPLES) {
			const { backgroundColor } = sessionColor(sample);
			expect(backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
			for (const value of channels(backgroundColor)) {
				expect(value).toBeGreaterThanOrEqual(0x99);
				expect(value).toBeLessThanOrEqual(0xdf);
			}
		}
	});

	it("does not throw on empty input and uses a dark foreground", () => {
		const result = sessionColor("");
		expect(result.color).toBe("#1f2937");
	});

	it("varies colors across different session ids", () => {
		const colors = new Set(
			SAMPLES.slice(6).map((s) => sessionColor(s).backgroundColor),
		);
		expect(colors.size).toBeGreaterThan(20);
	});
});
