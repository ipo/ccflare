import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@ccflare/config";
import { DatabaseFactory } from "@ccflare/database";
import {
	GROK_OAUTH_CLIENT_ID,
	GROK_OAUTH_REDIRECT_URI,
} from "@ccflare/providers";
import { createOAuthFlow, stopAllOAuthLoopbackServers } from "./index";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function createTestContext() {
	const tempDir = mkdtempSync(join(tmpdir(), "ccflare-oauth-flow-"));
	tempDirs.push(tempDir);

	const config = new Config(join(tempDir, "config.json"));
	DatabaseFactory.reset();
	DatabaseFactory.initialize(join(tempDir, "ccflare.db"));
	const dbOps = DatabaseFactory.getInstance();

	return { config, dbOps };
}

afterEach(() => {
	stopAllOAuthLoopbackServers();
	globalThis.fetch = originalFetch;
	DatabaseFactory.reset();

	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

describe("OAuthFlow", () => {
	it("rejects a Grok loopback callback whose state does not match", async () => {
		const { config, dbOps } = createTestContext();
		globalThis.fetch = Object.assign(
			async () =>
				Response.json({
					issuer: "https://auth.x.ai",
					authorization_endpoint: "https://auth.x.ai/authorize",
					token_endpoint: "https://auth.x.ai/token",
					jwks_uri: "https://auth.x.ai/jwks",
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		const flow = await (await createOAuthFlow(dbOps, config)).begin({
			name: "grok-state-mismatch",
			provider: "grok",
		});
		const response = await originalFetch(
			`${GROK_OAUTH_REDIRECT_URI}?code=bad&state=wrong`,
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("state mismatch");
		await expect(flow.completion).rejects.toThrow("state mismatch");
		expect(dbOps.getAuthSession(flow.sessionId)).toBeNull();
	});

	it("auto-completes Grok loopback login only after state and signed ID-token validation", async () => {
		const { config, dbOps } = createTestContext();
		const keys = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const jwk = {
			...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
			kid: "flow-key",
		};
		let expectedNonce = "";
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.startsWith(GROK_OAUTH_REDIRECT_URI)) {
					return originalFetch(input, init);
				}
				if (url.endsWith("openid-configuration")) {
					return Response.json({
						issuer: "https://auth.x.ai",
						authorization_endpoint: "https://auth.x.ai/authorize",
						token_endpoint: "https://auth.x.ai/token",
						jwks_uri: "https://auth.x.ai/jwks",
						id_token_signing_alg_values_supported: ["RS256"],
					});
				}
				if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
				const encode = (value: unknown) =>
					Buffer.from(JSON.stringify(value)).toString("base64url");
				const header = encode({ alg: "RS256", kid: "flow-key" });
				const payload = encode({
					iss: "https://auth.x.ai",
					aud: GROK_OAUTH_CLIENT_ID,
					exp: Math.floor(Date.now() / 1000) + 300,
					nonce: expectedNonce,
					sub: "persisted-grok-subject",
				});
				const signature = Buffer.from(
					await crypto.subtle.sign(
						"RSASSA-PKCS1-v1_5",
						keys.privateKey,
						new TextEncoder().encode(`${header}.${payload}`),
					),
				).toString("base64url");
				return Response.json({
					access_token: "grok-flow-access",
					refresh_token: "grok-flow-refresh",
					expires_in: 3600,
					id_token: `${header}.${payload}.${signature}`,
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const flow = await (await createOAuthFlow(dbOps, config)).begin({
			name: "grok-loopback-account",
			provider: "grok",
		});
		const authUrl = new URL(flow.authUrl);
		expectedNonce = authUrl.searchParams.get("nonce") ?? "";
		expect(expectedNonce).not.toBe("");
		const state = authUrl.searchParams.get("state");
		expect(state).not.toBe(flow.pkce.verifier);
		const callback = await originalFetch(
			`${GROK_OAUTH_REDIRECT_URI}?code=grok-code&state=${state}`,
		);
		expect(callback.status).toBe(200);
		await flow.completion;
		expect(dbOps.getAccountByName("grok-loopback-account")).toMatchObject({
			provider: "grok",
			access_token: "grok-flow-access",
			refresh_token: "grok-flow-refresh",
			oauth_subject: "persisted-grok-subject",
		});
	});

	it("stores the auth flow in auth_sessions with generic state_json", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);

		const result = await oauthFlow.begin({
			name: "claude-code-session-account",
			provider: "claude-code",
		});

		const row = dbOps.getAuthSession(result.sessionId);

		expect(row).toEqual(
			expect.objectContaining({
				provider: "claude-code",
				authMethod: "oauth",
				accountName: "claude-code-session-account",
			}),
		);
		expect(JSON.parse(row?.stateJson ?? "{}")).toEqual(
			expect.objectContaining({
				verifier: result.pkce.verifier,
				state: result.pkce.verifier,
				status: "pending",
			}),
		);
	});

	it("starts a Claude Code OAuth flow with the hosted callback redirect URI", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);

		const result = await oauthFlow.begin({
			name: "claude-code-oauth-account",
			provider: "claude-code",
		});

		const authUrl = new URL(result.authUrl);
		expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
			"https://claude.ai/oauth/authorize",
		);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(
			"https://platform.claude.com/oauth/code/callback",
		);
		expect(authUrl.searchParams.get("state")).toBe(result.pkce.verifier);
		expect(authUrl.searchParams.get("scope")).toContain(
			"user:sessions:claude_code",
		);
	});

	it("starts a Codex OAuth flow with the expected auth URL and auth session", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);

		const result = await oauthFlow.begin({
			name: "codex-oauth-account",
			provider: "codex",
		});

		const authUrl = new URL(result.authUrl);
		expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
			"https://auth.openai.com/oauth/authorize",
		);
		expect(authUrl.searchParams.get("client_id")).toBe(
			"app_EMoamEEZ73f0CkXaXp7hrann",
		);
		expect(authUrl.searchParams.get("scope")).toBe(
			"openid profile email offline_access api.connectors.read api.connectors.invoke",
		);
		expect(authUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true");
		expect(authUrl.searchParams.get("originator")).toBe("codex_cli_rs");

		expect(dbOps.getAuthSession(result.sessionId)).toEqual(
			expect.objectContaining({
				provider: "codex",
				authMethod: "oauth",
				accountName: "codex-oauth-account",
			}),
		);
		expect(
			JSON.parse(dbOps.getAuthSession(result.sessionId)?.stateJson ?? "{}"),
		).toEqual(
			expect.objectContaining({
				verifier: result.pkce.verifier,
				state: result.pkce.verifier,
				status: "pending",
			}),
		);
	});

	it("completes Codex directly, stops its listener, and immediately binds the next login", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);
		const flowResult = await oauthFlow.begin({
			name: "codex-complete-account",
			provider: "codex",
		});

		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				expect(request.url).toBe("https://auth.openai.com/oauth/token");
				expect(await request.text()).toContain(
					"client_id=app_EMoamEEZ73f0CkXaXp7hrann",
				);

				return new Response(
					JSON.stringify({
						access_token: "openai-access-token",
						refresh_token: "openai-refresh-token",
						expires_in: 3600,
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					},
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const createdAccount = await oauthFlow.complete({
			sessionId: flowResult.sessionId,
			code: "codex-auth-code",
		});
		expect(await flowResult.completion).toEqual(createdAccount);

		const nextFlow = await oauthFlow.begin({
			name: "codex-next-account",
			provider: "codex",
		});
		expect(nextFlow.completion).toBeInstanceOf(Promise);

		expect(createdAccount).toEqual({
			id: expect.any(String),
			name: "codex-complete-account",
			provider: "codex",
			authType: "oauth",
		});

		expect(dbOps.getAccount(createdAccount.id)).toEqual(
			expect.objectContaining({
				id: createdAccount.id,
				name: "codex-complete-account",
				provider: "codex",
				auth_method: "oauth",
				api_key: null,
				access_token: "openai-access-token",
				refresh_token: "openai-refresh-token",
				expires_at: expect.any(Number),
			}),
		);
		expect(dbOps.getAuthSession(flowResult.sessionId)).toEqual(
			expect.objectContaining({
				id: flowResult.sessionId,
			}),
		);
		expect(
			JSON.parse(dbOps.getAuthSession(flowResult.sessionId)?.stateJson ?? "{}"),
		).toEqual(
			expect.objectContaining({
				status: "completed",
				state: flowResult.pkce.verifier,
			}),
		);
	});
	it("begins a Kimi device flow without PKCE and stores the device code", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);

		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				expect(request.url).toBe(
					"https://auth.kimi.com/api/oauth/device_authorization",
				);

				return new Response(
					JSON.stringify({
						device_code: "kimi-device-code",
						user_code: "ABCD-1234",
						verification_uri: "https://www.kimi.com/code/authorize_device",
						verification_uri_complete:
							"https://www.kimi.com/code/authorize_device?user_code=ABCD-1234",
						expires_in: 1800,
						interval: 5,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const result = await oauthFlow.begin({
			name: "kimi-device-account",
			provider: "kimi",
		});

		expect(result.authUrl).toBe(
			"https://www.kimi.com/code/authorize_device?user_code=ABCD-1234",
		);
		expect(result.userCode).toBe("ABCD-1234");
		expect(result.pkce.verifier).toBe("kimi-device-code");
		expect(
			JSON.parse(dbOps.getAuthSession(result.sessionId)?.stateJson ?? "{}"),
		).toEqual(
			expect.objectContaining({
				verifier: "kimi-device-code",
				status: "pending",
			}),
		);
	});
});
