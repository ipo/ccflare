import type { Account } from "@ccflare/types";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken: string; // Always required - either new token or existing one
}

export interface RateLimitInfo {
	isRateLimited: boolean;
	resetTime?: number;
	statusHeader?: string;
	remaining?: number;
}

export type QuotaSourceState = "ok" | "failed";
export type ProviderQuotaState = "ok" | "partial" | "failed";

export interface QuotaSourceResult {
	state: QuotaSourceState;
	status?: number;
	data?: unknown;
	error?: string;
}

export interface ProviderQuotaReport {
	state: ProviderQuotaState;
	collectedAt: string;
	sources: Record<string, QuotaSourceResult>;
}

export interface Provider {
	name: string;
	defaultBaseUrl: string;

	/**
	 * Whether the provider supports websocket upgrades for the given upstream path.
	 */
	supportsWebSocket?(upstreamPath: string): boolean;

	/**
	 * Refresh the access token for an account
	 */
	refreshToken?(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult>;

	/**
	 * Fetch provider-native quota information for one OAuth account.
	 */
	fetchQuota?(
		account: Account,
		fetchFn?: typeof globalThis.fetch,
	): Promise<ProviderQuotaReport>;

	/**
	 * Build the target URL for the provider
	 */
	buildUrl(upstreamPath: string, query: string, account?: Account): string;

	/**
	 * Prepare headers for the provider request
	 */
	prepareHeaders(headers: Headers, account: Account | null): Headers;

	/**
	 * Parse rate limit information from response
	 */
	parseRateLimit(response: Response): RateLimitInfo;

	/**
	 * Process the response before returning to client
	 */
	processResponse(
		response: Response,
		account: Account | null,
	): Promise<Response>;

	/**
	 * Extract usage information from response if available
	 */
	extractUsageInfo?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;

	/**
	 * Check if the response is a streaming response
	 */
	isStreamingResponse?(response: Response): boolean;
}

// OAuth-specific types
export interface OAuthProviderConfig {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
}

export interface OAuthProvider {
	getOAuthConfig(): OAuthProviderConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string;
}

export interface PKCEChallenge {
	verifier: string;
	challenge: string;
}

export interface TokenResult {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
}
