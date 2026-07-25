import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import type {
	ModelCatalogVersionResult,
	Provider,
	ProviderQuotaState,
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
}

export interface AccountQuotaResponse {
	account: {
		id: string;
		name: string;
		provider: AccountProvider;
	};
	state: ProviderQuotaState;
	collectedAt: string;
	sources: Record<string, QuotaSourceResult>;
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
	getRuntimeHealth?: () => RuntimeHealth;
}
