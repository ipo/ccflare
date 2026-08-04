import type { Logger } from "@ccflare/logger";
import type { Account } from "@ccflare/types";
import type { TokenRefreshResult } from "./types";

const TOKEN_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Provider-specific configuration for building a token refresh request.
 */
export interface RefreshRequestConfig {
	/** Token endpoint URL */
	tokenUrl: string;
	/** Content-Type header for the request */
	contentType: "application/json" | "application/x-www-form-urlencoded";
	/** Build the request body given the refresh token and client ID */
	buildBody(refreshToken: string, clientId: string): string;
	/** Parse the successful JSON response into a TokenRefreshResult */
	parseTokens(
		json: Record<string, unknown>,
		account: Account,
	): TokenRefreshResult;
}

/**
 * Shared refresh-token orchestration.
 *
 * Both ClaudeCodeProvider and CodexProvider follow the same high-level flow:
 *   1. validate a refresh token exists
 *   2. POST to a token endpoint
 *   3. parse provider error payloads on failure
 *   4. log and throw a normalized error
 *   5. return { accessToken, expiresAt, refreshToken }
 *
 * This helper owns the orchestration. Provider-specific details (endpoint URL,
 * body format, response shape) are passed in via `config`.
 */
export async function executeTokenRefresh(
	account: Account,
	clientId: string,
	config: RefreshRequestConfig,
	log: Logger,
	signal?: AbortSignal,
): Promise<TokenRefreshResult> {
	if (!account.refresh_token) {
		throw new Error(`No refresh token available for account ${account.name}`);
	}

	const timeoutSignal = AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS);
	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": config.contentType,
		},
		body: config.buildBody(account.refresh_token, clientId),
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
	});

	if (!response.ok) {
		let errorMessage = response.statusText;
		let errorData: unknown = null;
		try {
			errorData = await response.json();
			const errorObj = errorData as {
				error?: string;
				error_description?: string;
				message?: string;
			};
			errorMessage =
				errorObj.error_description ||
				errorObj.message ||
				errorObj.error ||
				errorMessage;
		} catch {
			// Fall back to the HTTP status text
		}
		log.error(
			`Token refresh failed for ${account.name}: Status ${response.status}, Error: ${errorMessage}`,
			errorData,
		);
		throw new Error(
			`Failed to refresh token for account ${account.name}: ${errorMessage}`,
		);
	}

	const json = (await response.json()) as Record<string, unknown>;
	return config.parseTokens(json, account);
}
