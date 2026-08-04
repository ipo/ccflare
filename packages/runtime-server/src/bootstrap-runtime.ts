import {
	type AccountQuotaRefresher,
	APIRouter,
	createAccountQuotaService,
} from "@ccflare/api";
import { Config, type RuntimeConfig } from "@ccflare/config";
import {
	container,
	registerDisposable,
	SERVICE_KEYS,
	setPricingLogger,
	TIME_CONSTANTS,
} from "@ccflare/core";
import type { DatabaseOperations } from "@ccflare/database";
import { AsyncDbWriter, DatabaseFactory } from "@ccflare/database";
import { Logger } from "@ccflare/logger";
import { providerRegistry } from "@ccflare/providers";
import {
	getUsageWorker,
	getUsageWorkerHealth,
	type ProxyContext,
	SessionStrategy,
	WebSocketTranscriptRecorder,
} from "@ccflare/proxy";
import { AccountCredentialManager } from "./account-credential-manager";

export type BootstrappedRuntime = {
	config: Config;
	dbOps: DatabaseOperations;
	log: Logger;
	asyncWriter: AsyncDbWriter;
	apiRouter: APIRouter;
	accountQuotaService: AccountQuotaRefresher;
	credentialManager: AccountCredentialManager;
	proxyContext: ProxyContext;
	runtimeConfig: RuntimeConfig;
};

function createRuntimeConfig(config: Config, port: number): RuntimeConfig {
	return {
		clientId: config.get(
			"client_id",
			"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		) as string,
		retry: {
			attempts: config.get("retry_attempts", 3) as number,
			delayMs: config.get("retry_delay_ms", 1000) as number,
			backoff: config.get("retry_backoff", 2) as number,
		},
		sessionDurationMs: config.get(
			"session_duration_ms",
			TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		) as number,
		port,
	};
}

function wireStrategyHotReload(
	config: Config,
	log: Logger,
	dbOps: DatabaseOperations,
	proxyContext: ProxyContext,
	runtimeConfig: RuntimeConfig,
): void {
	config.on("change", (changeType, fieldName) => {
		if (fieldName === "strategy") {
			log.info(`Strategy configuration changed: ${changeType}`);
			const newStrategyName = config.getStrategy();
			if (newStrategyName === "session") {
				const strategy = new SessionStrategy(runtimeConfig.sessionDurationMs);
				strategy.initialize(dbOps);
				proxyContext.strategy = strategy;
			}
		}
	});
}

export function bootstrapRuntime(
	port: number,
	serverLog: Logger,
): BootstrappedRuntime {
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, serverLog);

	const config = container.resolve<Config>(SERVICE_KEYS.Config);
	const runtimeConfig = createRuntimeConfig(config, port);

	DatabaseFactory.initialize(undefined, {
		sessionDurationMs: runtimeConfig.sessionDurationMs,
	});

	const dbOps = DatabaseFactory.getInstance();
	const log = container.resolve<Logger>(SERVICE_KEYS.Logger);
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	const asyncWriter = new AsyncDbWriter();
	container.registerInstance(SERVICE_KEYS.AsyncWriter, asyncWriter);
	registerDisposable(asyncWriter);

	const websocketRecorder = new WebSocketTranscriptRecorder(dbOps);

	const pricingLogger = new Logger("Pricing");
	container.registerInstance(SERVICE_KEYS.PricingLogger, pricingLogger);
	setPricingLogger(pricingLogger);

	const credentialManager = new AccountCredentialManager(
		dbOps,
		runtimeConfig.clientId,
		(provider) => providerRegistry.getProvider(provider),
	);
	const accountQuotaService = createAccountQuotaService(
		dbOps,
		(provider) => providerRegistry.getProvider(provider),
		credentialManager,
	);
	const apiRouter = new APIRouter({
		config,
		dbOps,
		getProvider: (provider) => providerRegistry.getProvider(provider),
		getProviders: () => providerRegistry.listProviders(),
		credentialManager,
		accountQuotaService,
		getRuntimeHealth: () => ({
			asyncWriter: {
				healthy: asyncWriter.isHealthy(),
				failureCount: asyncWriter.getFailureCount(),
				queuedJobs: asyncWriter.getQueueSize(),
			},
			usageWorker: getUsageWorkerHealth(),
			websocketRecorder: websocketRecorder.getHealthSnapshot(),
		}),
	});

	const strategy = new SessionStrategy(runtimeConfig.sessionDurationMs);
	strategy.initialize(dbOps);

	const proxyContext: ProxyContext = {
		strategy,
		dbOps,
		runtime: runtimeConfig,
		providerRegistry,
		credentialManager,
		asyncWriter,
		usageWorker: getUsageWorker(),
		websocketRecorder,
	};

	wireStrategyHotReload(config, log, dbOps, proxyContext, runtimeConfig);

	return {
		config,
		dbOps,
		log,
		asyncWriter,
		apiRouter,
		accountQuotaService,
		credentialManager,
		proxyContext,
		runtimeConfig,
	};
}

export function logInitialAccountStatus(
	log: Logger,
	dbOps: DatabaseOperations,
): void {
	const accounts = dbOps.getAllAccounts();
	const activeAccounts = accounts.filter(
		(account) =>
			!account.paused &&
			(!account.expires_at || account.expires_at > Date.now()),
	);

	log.info(
		`Loaded ${accounts.length} accounts (${activeAccounts.length} active)`,
	);

	if (activeAccounts.length === 0) {
		log.warn(
			"No active accounts available - requests will be forwarded without authentication",
		);
	}
}
