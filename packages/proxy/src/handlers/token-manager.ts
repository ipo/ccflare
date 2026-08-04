import { Logger } from "@ccflare/logger";
import type { Account } from "@ccflare/types";
import type { ResolvedProxyContext } from "./proxy-types";

const log = new Logger("TokenManager");

/**
 * Refresh after an upstream rejects the token, reusing credentials another
 * caller may already have persisted.
 * @param account - The account to refresh token for
 * @param ctx - The proxy context
 * @returns Promise resolving to the new access token
 * @throws {TokenRefreshError} If token refresh fails
 * @throws {ServiceUnavailableError} If refresh promise is not found
 */
export async function refreshAccessTokenSafe(
	account: Account,
	ctx: ResolvedProxyContext,
): Promise<string> {
	const refreshed = await ctx.credentialManager.refreshAfterUnauthorized(
		account,
		account.access_token ?? "",
	);
	return refreshed.access_token ?? "";
}

/**
 * Gets a valid access token for an account, refreshing if necessary
 * @param account - The account to get token for
 * @param ctx - The proxy context
 * @returns Promise resolving to a valid access token
 */
export async function getValidAccessToken(
	account: Account,
	ctx: ResolvedProxyContext,
): Promise<string> {
	// API key accounts don't use access tokens
	if (!account.refresh_token && account.api_key) {
		// Return empty string - the API key will be used in prepareHeaders
		return "";
	}

	const refreshed = await ctx.credentialManager.getValidAccount(account);
	if (!refreshed.access_token) {
		log.warn(`OAuth account ${account.name} has no usable access token`);
		return "";
	}
	return refreshed.access_token;
}
