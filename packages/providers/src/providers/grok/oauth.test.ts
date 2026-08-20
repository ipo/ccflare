import { afterEach, describe, expect, it } from "bun:test";
import { originalFetch } from "../../test-helpers";
import {
	GROK_OAUTH_CLIENT_ID,
	GROK_OAUTH_REDIRECT_URI,
	GROK_OAUTH_SCOPES,
	GrokOAuthProvider,
} from "./oauth";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("GrokOAuthProvider", () => {
	it("uses discovered authorization code PKCE, frozen scopes, state, nonce and referrer", async () => {
		globalThis.fetch = Object.assign(
			async () =>
				Response.json({
					issuer: "https://auth.x.ai",
					authorization_endpoint: "https://auth.x.ai/authorize-discovered",
					token_endpoint: "https://auth.x.ai/token-discovered",
					jwks_uri: "https://auth.x.ai/jwks",
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		const provider = new GrokOAuthProvider();
		const config = await provider.discoverConfig();
		const url = new URL(
			provider.generateAuthUrl(config, {
				verifier: "verifier",
				challenge: "challenge",
				state: "state-value",
				nonce: "nonce-value",
			}),
		);
		expect(url.origin + url.pathname).toBe(
			"https://auth.x.ai/authorize-discovered",
		);
		expect(url.searchParams.get("client_id")).toBe(GROK_OAUTH_CLIENT_ID);
		expect(url.searchParams.get("redirect_uri")).toBe(GROK_OAUTH_REDIRECT_URI);
		expect(url.searchParams.get("scope")).toBe(GROK_OAUTH_SCOPES.join(" "));
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("state")).toBe("state-value");
		expect(url.searchParams.get("nonce")).toBe("nonce-value");
		expect(url.searchParams.get("referrer")).toBe("grok-build");
	});

	it("verifies a signed ID token before returning the persisted subject", async () => {
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
			kid: "test-key",
		};
		const header = encode({ alg: "RS256", kid: "test-key" });
		const payload = encode({
			iss: "https://auth.x.ai",
			aud: GROK_OAUTH_CLIENT_ID,
			exp: Math.floor(Date.now() / 1000) + 300,
			nonce: "expected-nonce",
			sub: "verified-user",
		});
		const signature = Buffer.from(
			await crypto.subtle.sign(
				"RSASSA-PKCS1-v1_5",
				keys.privateKey,
				new TextEncoder().encode(`${header}.${payload}`),
			),
		).toString("base64url");
		const token = `${header}.${payload}.${signature}`;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("openid-configuration"))
					return Response.json({
						issuer: "https://auth.x.ai",
						authorization_endpoint: "https://auth.x.ai/authorize",
						token_endpoint: "https://auth.x.ai/token",
						jwks_uri: "https://auth.x.ai/jwks",
						id_token_signing_alg_values_supported: ["RS256"],
					});
				if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
				const request = new Request(input, init);
				expect(request.headers.get("x-grok-client-version")).toBe("1.0.6");
				return Response.json({
					access_token: "access",
					refresh_token: "refresh",
					expires_in: 3600,
					id_token: token,
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		const result = await new GrokOAuthProvider().exchangeCode(
			"code",
			"verifier",
			{
				authorizeUrl: "https://auth.x.ai/authorize",
				tokenUrl: "https://auth.x.ai/token",
				clientId: GROK_OAUTH_CLIENT_ID,
				scopes: [...GROK_OAUTH_SCOPES],
				redirectUri: GROK_OAUTH_REDIRECT_URI,
			},
			{ nonce: "expected-nonce" },
		);
		expect(result).toMatchObject({
			accessToken: "access",
			refreshToken: "refresh",
			oauthSubject: "verified-user",
		});
		await expect(
			new GrokOAuthProvider().exchangeCode(
				"code",
				"verifier",
				{
					authorizeUrl: "https://auth.x.ai/authorize",
					tokenUrl: "https://auth.x.ai/token",
					clientId: GROK_OAUTH_CLIENT_ID,
					scopes: [...GROK_OAUTH_SCOPES],
					redirectUri: GROK_OAUTH_REDIRECT_URI,
				},
				{ nonce: "wrong" },
			),
		).rejects.toThrow("claims are invalid");
	});
});
