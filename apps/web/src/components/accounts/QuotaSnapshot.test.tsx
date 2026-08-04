import { describe, expect, it } from "bun:test";
import type { AccountQuotaSnapshot } from "@ccflare/api";
import { renderToStaticMarkup } from "react-dom/server";
import { QuotaSnapshot } from "./QuotaSnapshot";

describe("QuotaSnapshot", () => {
	it("renders every account, model, and meter quota window", () => {
		const snapshot: AccountQuotaSnapshot = {
			state: "fresh",
			collectedAt: "2026-08-04T16:00:00.000Z",
			lastAttemptAt: "2026-08-04T16:00:00.000Z",
			error: null,
			windows: [
				{
					id: "primary-5h",
					label: "Primary window",
					period: "5h",
					scope: "account",
					usedPercent: 28,
					resetAt: "2026-08-04T18:00:00.000Z",
				},
				{
					id: "weekly-opus",
					label: "Weekly Opus",
					period: "7d",
					scope: "model",
					model: "opus",
					usedPercent: 52,
				},
				{
					id: "spark-meter",
					label: "Spark allowance",
					period: "weekly",
					scope: "meter",
					model: "codex_bengalfox",
					usedPercent: 10,
					used: 10,
					limit: 100,
				},
			],
		};

		const html = renderToStaticMarkup(<QuotaSnapshot snapshot={snapshot} />);

		expect(html).toContain("Primary window");
		expect(html).toContain("5h");
		expect(html).toContain("Weekly Opus");
		expect(html).toContain("Model · opus");
		expect(html).toContain("Meter · codex_bengalfox");
		expect(html).toContain("Resets");
		expect(html).toContain("10 of 100 used");
	});

	it("shows an empty error snapshot", () => {
		const html = renderToStaticMarkup(
			<QuotaSnapshot
				snapshot={{
					state: "error",
					collectedAt: null,
					lastAttemptAt: "2026-08-04T16:00:00.000Z",
					error: "quota unavailable",
					windows: [],
				}}
			/>,
		);

		expect(html).toContain("Unavailable");
		expect(html).toContain("quota unavailable");
	});
});
