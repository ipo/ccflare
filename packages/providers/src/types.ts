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

export type ProxyErrorKind = "rate_limit" | "service_unavailable";

export interface ProxyErrorResponseOptions {
	kind: ProxyErrorKind;
	message: string;
	retryAfterSeconds?: number;
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

export interface ModelReasoningLevel {
	effort: string;
	description?: string;
}

export interface ProviderModelEntry {
	slug: string;
	displayName?: string;
	description?: string;
	defaultReasoningLevel?: string;
	supportedReasoningLevels: ModelReasoningLevel[];
	/** True for models known to exist but not advertised by the remote catalog. */
	hidden?: boolean;
}

export type ModelCatalogState = "ok" | "failed";

export interface ModelCatalogVersionResult {
	clientVersion: string;
	state: ModelCatalogState;
	status?: number;
	etag?: string;
	error?: string;
	models: ProviderModelEntry[];
	/**
	 * Number of model+effort combos removed from this tier because a newer
	 * client-version tier already advertises them.
	 */
	culledCount?: number;
}

export interface ProviderModelsReport {
	state: ProviderQuotaState;
	collectedAt: string;
	/** Ordered newest client version first; older tiers are culled of duplicates. */
	versions: ModelCatalogVersionResult[];
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
	 * Fetch the provider-native model catalog for one OAuth account.
	 */
	fetchModels?(
		account: Account,
		fetchFn?: typeof globalThis.fetch,
	): Promise<ProviderModelsReport>;

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

	/** Build a provider-native response for a proxy-generated error. */
	buildProxyErrorResponse(options: ProxyErrorResponseOptions): Response;

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

/**
 * Result of an OAuth device authorization request (RFC 8628).
 * `deviceCode` is the polling credential; the user approves at
 * `verificationUriComplete`.
 */
export interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	/** Seconds to wait between token polls. */
	interval: number;
	/** Epoch ms after which the device code is no longer valid. */
	expiresAt: number;
}

export interface OAuthProvider {
	getOAuthConfig(): OAuthProviderConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string;
	/**
	 * Device-code providers implement this instead of the PKCE redirect flow.
	 * When present, the OAuth flow starts here and `exchangeCode` receives the
	 * device code in its `verifier` argument, ignoring `code`.
	 */
	beginDeviceAuthorization?(
		config: OAuthProviderConfig,
	): Promise<DeviceAuthorization>;
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
