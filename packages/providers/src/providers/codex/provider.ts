import { Logger } from "@ccflare/logger";
import { type Account, getProviderDefaultBaseUrl } from "@ccflare/types";
import { deleteTransportHeaders } from "../../base";
import { collectQuotaSources } from "../../quota";
import {
	executeTokenRefresh,
	type RefreshRequestConfig,
} from "../../token-refresh";
import type { ProviderQuotaReport, TokenRefreshResult } from "../../types";
import {
	OPENAI_OAUTH_CLIENT_ID,
	OPENAI_OAUTH_TOKEN_URL,
} from "../openai/oauth";
import {
	OpenAIProvider,
	parseInteger,
	parseResetTime,
} from "../openai/provider";
import { CodexOAuthProvider } from "./oauth";

const CODEX_CLIENT_VERSION = "0.144.1";
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLIENT_VERSION} (Mac OS; arm64)`;
const log = new Logger("CodexProvider");
const PROVIDER_NAME = "codex" as const;
const DEFAULT_BASE_URL = getProviderDefaultBaseUrl(PROVIDER_NAME);

function decodeCodexAccountId(accessToken: string): string | undefined {
	try {
		const payload = accessToken.split(".")[1];
		if (!payload) {
			return undefined;
		}
		const claims = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as Record<string, unknown>;
		const authClaims = claims["https://api.openai.com/auth"];

		if (
			authClaims &&
			typeof authClaims === "object" &&
			"chatgpt_account_id" in authClaims &&
			typeof authClaims.chatgpt_account_id === "string"
		) {
			return authClaims.chatgpt_account_id;
		}

		if (typeof claims.chatgpt_account_id === "string") {
			return claims.chatgpt_account_id;
		}
		if (typeof claims.account_id === "string") {
			return claims.account_id;
		}
	} catch {
		// Opaque or malformed access tokens simply omit the optional account header.
	}

	return undefined;
}

function getCodexQuotaBaseUrl(account: Account): string {
	const url = new URL(account.base_url ?? DEFAULT_BASE_URL);
	url.pathname = url.pathname.replace(/\/codex\/?$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/+$/, "");
}

const CODEX_REFRESH_CONFIG: RefreshRequestConfig = {
	tokenUrl: OPENAI_OAUTH_TOKEN_URL,
	contentType: "application/x-www-form-urlencoded",
	buildBody(refreshToken: string, _clientId: string) {
		return new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: OPENAI_OAUTH_CLIENT_ID,
		}).toString();
	},
	parseTokens(json: Record<string, unknown>, account: Account) {
		const expiresAt =
			(json.expires_at as number | undefined) ??
			Date.now() + ((json.expires_in as number | undefined) ?? 3600) * 1000;
		return {
			accessToken: json.access_token as string,
			expiresAt,
			refreshToken:
				(json.refresh_token as string | undefined) ??
				account.refresh_token ??
				"",
		};
	},
};

export class CodexProvider extends OpenAIProvider {
	name: string = PROVIDER_NAME;
	defaultBaseUrl: string = DEFAULT_BASE_URL;

	supportsWebSocket(upstreamPath: string): boolean {
		return upstreamPath === "/responses";
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		return executeTokenRefresh(account, _clientId, CODEX_REFRESH_CONFIG, log);
	}

	async fetchQuota(
		account: Account,
		fetchFn: typeof globalThis.fetch = globalThis.fetch,
	): Promise<ProviderQuotaReport> {
		if (!account.access_token) {
			throw new Error(
				`No access token available for Codex account ${account.name}`,
			);
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${account.access_token}`,
			Accept: "application/json",
			"User-Agent": CODEX_USER_AGENT,
		};
		const remoteAccountId = decodeCodexAccountId(account.access_token);
		if (remoteAccountId) {
			headers["ChatGPT-Account-Id"] = remoteAccountId;
		}

		const baseUrl = getCodexQuotaBaseUrl(account);
		return collectQuotaSources(
			[
				{ name: "usage", url: `${baseUrl}/wham/usage` },
				{ name: "account", url: `${baseUrl}/wham/accounts/check` },
				{
					name: "resetCredits",
					url: `${baseUrl}/wham/rate-limit-reset-credits`,
				},
			],
			headers,
			fetchFn,
			[account.access_token],
		);
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);

		if (account?.access_token) {
			newHeaders.set("Authorization", `Bearer ${account.access_token}`);
		}

		// Codex-specific headers
		newHeaders.set("originator", "codex_cli_rs");
		newHeaders.set("User-Agent", CODEX_USER_AGENT);
		newHeaders.set("Version", CODEX_CLIENT_VERSION);
		newHeaders.set("Openai-Beta", "responses=experimental");

		// Remove Anthropic-family headers that don't belong on Codex requests
		newHeaders.delete("x-api-key");
		newHeaders.delete("anthropic-version");

		deleteTransportHeaders(newHeaders);

		return newHeaders;
	}

	parseRateLimit(response: Response) {
		const primaryUsed = parseInteger(
			response.headers.get("x-codex-primary-used-percent"),
		);
		const secondaryUsed = parseInteger(
			response.headers.get("x-codex-secondary-used-percent"),
		);
		const resets = [
			parseResetTime(response.headers.get("x-codex-5h-reset-at")),
			parseResetTime(response.headers.get("x-codex-7d-reset-at")),
			parseResetTime(response.headers.get("x-codex-primary-reset-at")),
			parseResetTime(response.headers.get("x-codex-secondary-reset-at")),
		].filter((value): value is number => value !== undefined);

		if (
			primaryUsed !== undefined ||
			secondaryUsed !== undefined ||
			resets.length > 0
		) {
			const isRateLimited =
				response.status === 429 || primaryUsed === 100 || secondaryUsed === 100;

			return {
				isRateLimited,
				resetTime: resets.length > 0 ? Math.min(...resets) : undefined,
				statusHeader: isRateLimited ? "rate_limited" : "allowed",
			};
		}

		return super.parseRateLimit(response);
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		return new CodexOAuthProvider();
	}
}
