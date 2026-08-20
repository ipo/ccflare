import { isRecord } from "@ccflare/types";
import type {
	OAuthExchangeContext,
	OAuthProvider,
	OAuthProviderConfig,
	PKCEChallenge,
	TokenResult,
} from "../../types";
import { GROK_CLIENT_VERSION } from "./constants";

export const GROK_OAUTH_ISSUER = "https://auth.x.ai";
export const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_OAUTH_REDIRECT_URI = "http://127.0.0.1:1456/callback";
export const GROK_OAUTH_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"grok-cli:access",
	"api:access",
	"conversations:read",
	"conversations:write",
	"workspaces:read",
	"workspaces:write",
] as const;

interface Discovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	id_token_signing_alg_values_supported?: string[];
}

function decodePart(value: string): unknown {
	return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function discover(fetchFn: typeof fetch = fetch): Promise<Discovery> {
	const response = await fetchFn(
		`${GROK_OAUTH_ISSUER}/.well-known/openid-configuration`,
	);
	if (!response.ok)
		throw new Error(`Grok OIDC discovery failed with HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (
		!isRecord(value) ||
		value.issuer !== GROK_OAUTH_ISSUER ||
		typeof value.authorization_endpoint !== "string" ||
		typeof value.token_endpoint !== "string" ||
		typeof value.jwks_uri !== "string"
	) {
		throw new Error("Grok OIDC discovery response is invalid");
	}
	return value as unknown as Discovery;
}

async function verifyIdToken(
	token: string,
	nonce: string,
	metadata: Discovery,
): Promise<string> {
	const parts = token.split(".");
	if (parts.length !== 3)
		throw new Error("Grok login returned an invalid ID token");
	const header = decodePart(parts[0]);
	const claims = decodePart(parts[1]);
	if (
		!isRecord(header) ||
		!isRecord(claims) ||
		typeof header.alg !== "string" ||
		typeof header.kid !== "string"
	) {
		throw new Error("Grok login returned an invalid ID token");
	}
	const supported = metadata.id_token_signing_alg_values_supported;
	if (
		(supported && !supported.includes(header.alg)) ||
		!["RS256", "PS256", "ES256"].includes(header.alg)
	) {
		throw new Error("Grok ID token uses an unsupported signing algorithm");
	}
	const jwksResponse = await fetch(metadata.jwks_uri);
	if (!jwksResponse.ok)
		throw new Error(
			`Grok JWKS request failed with HTTP ${jwksResponse.status}`,
		);
	const jwks: unknown = await jwksResponse.json();
	if (!isRecord(jwks) || !Array.isArray(jwks.keys))
		throw new Error("Grok JWKS response is invalid");
	const jwk = jwks.keys.find((key) => isRecord(key) && key.kid === header.kid);
	if (!isRecord(jwk))
		throw new Error("Grok ID token signing key was not found");
	const algorithm: RsaHashedImportParams | EcKeyImportParams =
		header.alg === "ES256"
			? { name: "ECDSA", namedCurve: "P-256" }
			: {
					name: header.alg === "PS256" ? "RSA-PSS" : "RSASSA-PKCS1-v1_5",
					hash: "SHA-256",
				};
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk as JsonWebKey,
		algorithm,
		false,
		["verify"],
	);
	const verifyAlgorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams =
		header.alg === "ES256"
			? { name: "ECDSA", hash: "SHA-256" }
			: header.alg === "PS256"
				? { name: "RSA-PSS", saltLength: 32 }
				: "RSASSA-PKCS1-v1_5";
	const valid = await crypto.subtle.verify(
		verifyAlgorithm,
		key,
		Buffer.from(parts[2], "base64url"),
		new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
	);
	if (!valid) throw new Error("Grok ID token signature is invalid");
	const now = Math.floor(Date.now() / 1000);
	const audience = claims.aud;
	if (
		claims.iss !== metadata.issuer ||
		!(
			audience === GROK_OAUTH_CLIENT_ID ||
			(Array.isArray(audience) && audience.includes(GROK_OAUTH_CLIENT_ID))
		) ||
		(Array.isArray(audience) &&
			audience.length > 1 &&
			claims.azp !== GROK_OAUTH_CLIENT_ID) ||
		typeof claims.exp !== "number" ||
		claims.exp <= now ||
		(typeof claims.nbf === "number" && claims.nbf > now) ||
		claims.nonce !== nonce ||
		typeof claims.sub !== "string" ||
		!claims.sub.trim()
	) {
		throw new Error("Grok ID token claims are invalid");
	}
	return claims.sub;
}

export class GrokOAuthProvider implements OAuthProvider {
	async discoverConfig(): Promise<OAuthProviderConfig> {
		const metadata = await discover();
		return {
			authorizeUrl: metadata.authorization_endpoint,
			tokenUrl: metadata.token_endpoint,
			clientId: GROK_OAUTH_CLIENT_ID,
			scopes: [...GROK_OAUTH_SCOPES],
			redirectUri: GROK_OAUTH_REDIRECT_URI,
		};
	}

	getOAuthConfig(): OAuthProviderConfig {
		return {
			authorizeUrl: `${GROK_OAUTH_ISSUER}/authorize`,
			tokenUrl: `${GROK_OAUTH_ISSUER}/token`,
			clientId: GROK_OAUTH_CLIENT_ID,
			scopes: [...GROK_OAUTH_SCOPES],
			redirectUri: GROK_OAUTH_REDIRECT_URI,
		};
	}

	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string {
		const url = new URL(config.authorizeUrl);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", config.clientId);
		url.searchParams.set("redirect_uri", config.redirectUri);
		url.searchParams.set("scope", config.scopes.join(" "));
		url.searchParams.set("code_challenge", pkce.challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", pkce.state ?? pkce.verifier);
		url.searchParams.set("nonce", pkce.nonce ?? "");
		url.searchParams.set("referrer", "grok-build");
		return url.toString();
	}

	async exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
		context?: OAuthExchangeContext,
	): Promise<TokenResult> {
		if (!context?.nonce) throw new Error("Grok OAuth nonce is missing");
		const metadata = await discover();
		if (metadata.token_endpoint !== config.tokenUrl)
			throw new Error("Grok OIDC token endpoint changed during login");
		const response = await fetch(config.tokenUrl, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-grok-client-version": GROK_CLIENT_VERSION,
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: config.clientId,
				redirect_uri: config.redirectUri,
				code_verifier: verifier,
			}),
		});
		if (!response.ok)
			throw new Error(
				`Grok token exchange failed with HTTP ${response.status}`,
			);
		const value: unknown = await response.json();
		if (
			!isRecord(value) ||
			typeof value.access_token !== "string" ||
			typeof value.refresh_token !== "string" ||
			typeof value.expires_in !== "number" ||
			typeof value.id_token !== "string"
		)
			throw new Error("Grok token response is invalid");
		const oauthSubject = await verifyIdToken(
			value.id_token,
			context.nonce,
			metadata,
		);
		return {
			accessToken: value.access_token,
			refreshToken: value.refresh_token,
			expiresAt: Date.now() + value.expires_in * 1000,
			oauthSubject,
		};
	}
}
