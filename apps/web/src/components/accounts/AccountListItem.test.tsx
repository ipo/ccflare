import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@ccflare/api";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountListItem } from "./AccountListItem";

function account(isLimited: boolean): AccountResponse {
	return {
		id: "account-1",
		name: "Work account",
		provider: "codex",
		auth_method: "oauth",
		base_url: null,
		oauthSubject: null,
		requestCount: 12,
		totalRequests: 20,
		lastUsed: null,
		created: "2026-08-04T12:00:00.000Z",
		weight: 1,
		paused: false,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: {
			code: isLimited ? "rate_limited" : "ok",
			isLimited,
			until: isLimited ? "2026-08-04T18:00:00.000Z" : null,
		},
		rateLimitReset: isLimited ? "2026-08-04T18:00:00.000Z" : null,
		rateLimitRemaining: null,
		sessionInfo: { active: false, startedAt: null, requestCount: 0 },
		quota: null,
	};
}

const actions = {
	onPauseToggle: () => {},
	onResetRateLimit: () => {},
	onRemove: () => {},
	onRename: () => {},
};

describe("AccountListItem rate-limit controls", () => {
	it("keeps the countdown and offers a local reset while limited", () => {
		const html = renderToStaticMarkup(
			<AccountListItem account={account(true)} {...actions} />,
		);

		expect(html).toContain("Rate limit window");
		expect(html).toContain("Reset local rate limit");
	});

	it("does not offer a reset when the account is not limited", () => {
		const html = renderToStaticMarkup(
			<AccountListItem account={account(false)} {...actions} />,
		);

		expect(html).not.toContain("Reset local rate limit");
	});
});
