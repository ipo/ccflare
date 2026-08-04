import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import type {
	ModelCatalogVersionResult,
	Provider,
	ProviderQuotaState,
	ProviderQuotaWindow,
	QuotaSourceResult,
} from "@ccflare/providers";
import type {
	AccountProvider,
	AuthMethod,
	RuntimeHealth,
} from "@ccflare/types";

export interface AccountResponse {
	id: string;
	name: string;
	provider: AccountProvider;
	auth_method: AuthMethod;
	base_url: string | null;
	requestCount: number;
	totalRequests: number;
	lastUsed: string | null;
	created: string;
	weight: number;
	paused: boolean;
	tokenStatus: "valid" | "expired";
	tokenExpiresAt: string | null;
	rateLimitStatus: {
		code: string;
		isLimited: boolean;
		until: string | null;
	};
	rateLimitReset: string | null;
	rateLimitRemaining: number | null;
	sessionInfo: {
		active: boolean;
		startedAt: string | null;
		requestCount: number;
	};
	quota: AccountQuotaSnapshot | null;
}

export type AccountQuotaWindow = ProviderQuotaWindow;

export interface AccountQuotaSnapshot {
	windows: AccountQuotaWindow[];
	collectedAt: string | null;
	lastAttemptAt: string;
	state: "fresh" | "stale" | "error";
	error: string | null;
}

export interface AccountQuotaResponse {
	account: {
		id: string;
		name: string;
		provider: AccountProvider;
	};
	state: ProviderQuotaState;
	collectedAt: string;
	windows: AccountQuotaWindow[];
	sources: Record<string, QuotaSourceResult>;
}

export interface AccountQuotaRefresher {
	isSupported(provider: AccountProvider): boolean;
	refreshAccountQuota(
		accountId: string,
		signal?: AbortSignal,
	): Promise<AccountQuotaResponse>;
	shutdown?(reason?: Error): Promise<void>;
}

export interface AccountModelsResponse {
	account: {
		id: string;
		name: string;
		provider: AccountProvider;
	};
	state: ProviderQuotaState;
	collectedAt: string;
	versions: ModelCatalogVersionResult[];
}

export interface APIContext {
	config: Config;
	dbOps: DatabaseOperations;
	getProviders: () => string[];
	getProvider: (provider: AccountProvider) => Provider | undefined;
	accountQuotaService?: AccountQuotaRefresher;
	getRuntimeHealth?: () => RuntimeHealth;
}
