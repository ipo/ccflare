import { afterEach, describe, expect, it } from "bun:test";
import type { OAuthProvider } from "@ccflare/types";
import { ClaudeCodeProvider } from "./providers/claude-code/provider";
import { CodexProvider } from "./providers/codex/provider";
import { KimiProvider } from "./providers/kimi/provider";
import { createOAuthAccount, originalFetch } from "./test-helpers";
import { OAuthTokenRefreshError } from "./token-refresh";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("OAuth token refresh errors", () => {
	it("preserves sanitized invalid_grant, 401, and 403 details for every OAuth provider", async () => {
		const cases = [
			{
				provider: "kimi",
				implementation: new KimiProvider(),
				status: 400,
				code: "invalid_grant",
			},
			{
				provider: "codex",
				implementation: new CodexProvider(),
				status: 401,
				code: "invalid_token",
			},
			{
				provider: "claude-code",
				implementation: new ClaudeCodeProvider(),
				status: 403,
				code: "access_denied",
			},
		] as const;

		for (const testCase of cases) {
			const account = createOAuthAccount(testCase.provider as OAuthProvider);
			globalThis.fetch = Object.assign(
				async () =>
					Response.json(
						{
							error: testCase.code,
							error_description: `rejected ${account.refresh_token}`,
							access_token: "raw-provider-secret",
						},
						{ status: testCase.status },
					),
				{ preconnect: originalFetch.preconnect },
			) as typeof fetch;

			let caught: unknown;
			try {
				await testCase.implementation.refreshToken(account, "client-id");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(OAuthTokenRefreshError);
			const refreshError = caught as OAuthTokenRefreshError;
			expect(refreshError.httpStatus).toBe(testCase.status);
			expect(refreshError.oauthCode).toBe(testCase.code);
			expect(refreshError.requiresSignIn).toBe(true);
			expect(refreshError.safeDescription).toBe("rejected [REDACTED]");
			expect(refreshError.message).not.toContain(
				account.refresh_token as string,
			);
			expect(JSON.stringify(refreshError)).not.toContain("raw-provider-secret");
		}
	});

	it("keeps temporary token endpoint failures typed but does not require sign-in", async () => {
		const account = createOAuthAccount("kimi");
		globalThis.fetch = Object.assign(
			async () =>
				Response.json(
					{ error: "temporarily_unavailable", error_description: "try later" },
					{ status: 503 },
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		try {
			await new KimiProvider().refreshToken(account, "client-id");
			throw new Error("Expected refresh to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(OAuthTokenRefreshError);
			expect((error as OAuthTokenRefreshError).requiresSignIn).toBe(false);
		}
	});
});
