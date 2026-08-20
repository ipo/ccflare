export { generatePKCE } from "./pkce";

/**
 * Token result from an OAuth code exchange.
 * refreshToken is optional because not all providers return one on every exchange.
 */
export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	oauthSubject?: string;
}
