import { describe, expect, it } from "bun:test";
import { type AccountRow, toAccount } from "./account-row";

describe("toAccount", () => {
	it("maps weight, auth_method, base_url, and nullable refresh_token", () => {
		const row: AccountRow = {
			id: "account-1",
			name: "OpenAI API Key",
			provider: "openai",
			auth_method: "api_key",
			base_url: "https://example.com/v1",
			api_key: "sk-test",
			refresh_token: null,
			access_token: null,
			oauth_subject: null,
			expires_at: null,
			created_at: 123,
			last_used: 456,
			request_count: 2,
			total_requests: 9,
			rate_limited_until: null,
			session_start: null,
			session_request_count: 0,
			weight: 5,
			paused: 0,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
		};

		expect(toAccount(row)).toEqual({
			id: "account-1",
			name: "OpenAI API Key",
			provider: "openai",
			auth_method: "api_key",
			base_url: "https://example.com/v1",
			api_key: "sk-test",
			refresh_token: null,
			access_token: null,
			oauth_subject: null,
			expires_at: null,
			created_at: 123,
			last_used: 456,
			request_count: 2,
			total_requests: 9,
			rate_limited_until: null,
			session_start: null,
			session_request_count: 0,
			weight: 5,
			paused: false,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
		});
	});
});
