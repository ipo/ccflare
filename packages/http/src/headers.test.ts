import { describe, expect, it } from "bun:test";
import { sanitizeRequestHeaders } from "./headers";

describe("sanitizeRequestHeaders", () => {
	it("removes persisted auth and cookie headers", () => {
		const sanitized = sanitizeRequestHeaders(
			new Headers({
				authorization: "Bearer secret-token",
				"x-api-key": "secret-key",
				cookie: "session=secret",
				"content-type": "application/json",
			}),
		);

		expect(sanitized.get("authorization")).toBeNull();
		expect(sanitized.get("x-api-key")).toBeNull();
		expect(sanitized.get("cookie")).toBeNull();
		expect(sanitized.get("content-type")).toBe("application/json");
	});

	it("keeps session-id headers for post-processing extraction", () => {
		// The persisted copy is the only header set the post-processor sees;
		// stripping these here would silently break client_session_id extraction.
		const sanitized = sanitizeRequestHeaders(
			new Headers({
				"x-ccflare-session-id": "ccflare-session",
				"x-claude-code-session-id": "claude-session",
			}),
		);

		expect(sanitized.get("x-ccflare-session-id")).toBe("ccflare-session");
		expect(sanitized.get("x-claude-code-session-id")).toBe("claude-session");
	});
});
