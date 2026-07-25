import { Logger } from "@ccflare/logger";
import { type Account, getProviderDefaultBaseUrl } from "@ccflare/types";
import { deleteTransportHeaders } from "../../base";
import { collectQuotaSources } from "../../quota";
import {
	executeTokenRefresh,
	type RefreshRequestConfig,
} from "../../token-refresh";
import type { ProviderQuotaReport, TokenRefreshResult } from "../../types";
import { AnthropicProvider } from "../anthropic/provider";
import { CLAUDE_CODE_OAUTH_TOKEN_URL, ClaudeCodeOAuthProvider } from "./oauth";

const log = new Logger("ClaudeCodeProvider");
const PROVIDER_NAME = "claude-code" as const;
const DEFAULT_BASE_URL = getProviderDefaultBaseUrl(PROVIDER_NAME);
const CLAUDE_CODE_CLIENT_VERSION = "2.1.219";
const CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20";

const CLAUDE_CODE_REFRESH_CONFIG: RefreshRequestConfig = {
	tokenUrl: CLAUDE_CODE_OAUTH_TOKEN_URL,
	contentType: "application/json",
	buildBody(refreshToken: string, clientId: string) {
		return JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId,
		});
	},
	parseTokens(json: Record<string, unknown>, account: Account) {
		const refreshToken =
			(json.refresh_token as string) || (account.refresh_token ?? "");
		if (!json.refresh_token) {
			log.warn(
				`Claude Code refresh endpoint did not return a refresh_token for ${account.name} - continuing with previous one`,
			);
		}
		return {
			accessToken: json.access_token as string,
			expiresAt: Date.now() + (json.expires_in as number) * 1000,
			refreshToken,
		};
	},
};

export class ClaudeCodeProvider extends AnthropicProvider {
	name: string = PROVIDER_NAME;
	defaultBaseUrl: string = DEFAULT_BASE_URL;

	async refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult> {
		return executeTokenRefresh(
			account,
			clientId,
			CLAUDE_CODE_REFRESH_CONFIG,
			log,
		);
	}

	async fetchQuota(
		account: Account,
		fetchFn: typeof globalThis.fetch = globalThis.fetch,
	): Promise<ProviderQuotaReport> {
		if (!account.access_token) {
			throw new Error(
				`No access token available for Claude Code account ${account.name}`,
			);
		}

		const baseUrl = (account.base_url ?? this.defaultBaseUrl).replace(
			/\/+$/,
			"",
		);
		const headers = {
			Authorization: `Bearer ${account.access_token}`,
			"anthropic-beta": CLAUDE_CODE_OAUTH_BETA,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
			"User-Agent": `claude-cli/${CLAUDE_CODE_CLIENT_VERSION} (external, cli)`,
		};

		return collectQuotaSources(
			[
				{ name: "usage", url: `${baseUrl}/api/oauth/usage` },
				{ name: "profile", url: `${baseUrl}/api/oauth/profile` },
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

		// Remove api_key header -- Claude Code uses OAuth Bearer tokens
		newHeaders.delete("x-api-key");

		deleteTransportHeaders(newHeaders);

		return newHeaders;
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		return new ClaudeCodeOAuthProvider();
	}
}
