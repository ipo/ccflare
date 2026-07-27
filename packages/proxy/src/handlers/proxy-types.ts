import type { RuntimeConfig } from "@ccflare/config";
import type { AsyncDbWriter, DatabaseOperations } from "@ccflare/database";
import type { Provider, ProviderRegistry } from "@ccflare/providers";
import {
	type AccountProvider,
	isAccountProvider,
	type LoadBalancingStrategy,
} from "@ccflare/types";
import type { UsageWorkerTransport } from "../usage-worker";
import type { WebSocketTranscriptRecorder } from "../websocket-transcript-recorder";

export interface ProxyContext {
	strategy: LoadBalancingStrategy;
	dbOps: DatabaseOperations;
	runtime: RuntimeConfig;
	providerRegistry: ProviderRegistry;
	refreshInFlight: Map<string, Promise<string>>;
	asyncWriter: AsyncDbWriter;
	usageWorker: UsageWorkerTransport;
	websocketRecorder: WebSocketTranscriptRecorder;
}

export interface ResolvedProxyContext extends ProxyContext {
	provider: Provider;
	providerName: AccountProvider;
	upstreamPath: string;
}

export function resolveProxyContext(
	url: URL,
	ctx: ProxyContext,
): ResolvedProxyContext | null {
	const resolvedProvider = ctx.providerRegistry.resolveProvider(url.pathname);
	if (!resolvedProvider) {
		return null;
	}
	if (!isAccountProvider(resolvedProvider.provider.name)) {
		return null;
	}

	return {
		...ctx,
		provider: resolvedProvider.provider,
		providerName: resolvedProvider.provider.name,
		upstreamPath: resolvedProvider.upstreamPath,
	};
}

/** Error messages used throughout the proxy module */
export const ERROR_MESSAGES = {
	NO_ACCOUNTS:
		"No active accounts available - forwarding request without authentication",
	PROVIDER_CANNOT_HANDLE: "Provider cannot handle path",
	REFRESH_NOT_FOUND: "Refresh promise not found for account",
	UNAUTHENTICATED_FAILED: "Failed to forward unauthenticated request",
	ALL_ACCOUNTS_FAILED: "All accounts failed to proxy the request",
	TOKEN_REFRESH_FAILED: "Failed to refresh access token",
	PROXY_REQUEST_FAILED: "Failed to proxy request with account",
} as const;

/** Timing constants */
export const TIMING = {
	WORKER_SHUTDOWN_DELAY: 5000, // ms
} as const;

/** HTTP headers used in proxy operations */
export const HEADERS = {
	CONTENT_TYPE: "Content-Type",
	AUTHORIZATION: "Authorization",
} as const;
