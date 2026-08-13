import {
	type AccountQuotaRefresher,
	stopAllOAuthCallbackForwarders,
} from "@ccflare/api";
import { NETWORK, shutdown } from "@ccflare/core";
import { DatabaseFactory } from "@ccflare/database";
import { Logger, LogLevel } from "@ccflare/logger";
import { providerRegistry } from "@ccflare/providers";
import {
	closeAllWebSocketProxySessions,
	terminateUsageWorker,
	waitForProxyBackgroundTasks,
	websocketProxyHandler,
} from "@ccflare/proxy";
import { serve } from "bun";
import { bootstrapRuntime, logInitialAccountStatus } from "./bootstrap-runtime";
import { loadDashboardAssets, resetDashboardAssets } from "./dashboard-assets";
import { createServerFetchHandler } from "./fetch-handler";
import {
	type QuotaRefreshJob,
	startQuotaRefreshJob,
} from "./quota-refresh-job";
import { createStartupBanner } from "./startup-banner";
import { runStartupMaintenance } from "./startup-maintenance";

const serverLog = new Logger("Server");
const lifecycleLog = new Logger("ServerLifecycle", LogLevel.INFO, {
	silentConsole: false,
});

// Module-level server instance
let serverInstance: ReturnType<typeof serve> | null = null;
let stopRetentionJob: (() => Promise<void>) | null = null;
let quotaRefreshJob: QuotaRefreshJob | null = null;
let activeAccountQuotaService: AccountQuotaRefresher | null = null;
let serverStopPromise: Promise<void> | null = null;

export interface ServerHandle {
	port: number;
	stop: () => Promise<void>;
}

export interface StartServerOptions {
	port?: number;
	withDashboard?: boolean;
}

function stopRetentionMaintenance(): Promise<void> {
	const stop = stopRetentionJob;
	stopRetentionJob = null;
	return stop?.() ?? Promise.resolve();
}

async function stopQuotaRefresh(): Promise<void> {
	const activeJob = quotaRefreshJob;
	quotaRefreshJob = null;
	await activeJob?.stop();
}

function toError(scope: string, error: unknown): Error {
	if (error instanceof Error) {
		return new Error(`${scope}: ${error.message}`);
	}

	return new Error(`${scope}: ${String(error)}`);
}

function resetServerRuntimeState(): void {
	resetDashboardAssets();
	stopAllOAuthCallbackForwarders();
	DatabaseFactory.reset();
}

async function stopServerRuntime(): Promise<void> {
	if (serverStopPromise) {
		return serverStopPromise;
	}

	serverStopPromise = (async () => {
		const errors: Error[] = [];
		const activeServer = serverInstance;
		serverInstance = null;
		const quotaService = activeAccountQuotaService;
		activeAccountQuotaService = null;
		const quotaStopPromise = stopQuotaRefresh();
		const retentionStopPromise = stopRetentionMaintenance();

		try {
			await activeServer?.stop(true);
		} catch (error) {
			errors.push(toError("Failed to stop Bun server", error));
		}

		try {
			await quotaStopPromise;
		} catch (error) {
			errors.push(toError("Failed to stop quota refresh job", error));
		}

		try {
			await retentionStopPromise;
		} catch (error) {
			errors.push(toError("Failed to stop retention cleanup job", error));
		}

		try {
			await quotaService?.shutdown?.(new Error("Server shutting down"));
		} catch (error) {
			errors.push(toError("Failed to stop account quota service", error));
		}

		closeAllWebSocketProxySessions();

		try {
			await waitForProxyBackgroundTasks();
		} catch (error) {
			errors.push(toError("Failed to drain proxy background tasks", error));
		}

		try {
			await terminateUsageWorker();
		} catch (error) {
			errors.push(toError("Failed to stop usage worker", error));
		}

		try {
			await shutdown();
		} catch (error) {
			errors.push(toError("Failed to shutdown runtime disposables", error));
		}

		try {
			resetServerRuntimeState();
		} catch (error) {
			errors.push(toError("Failed to reset runtime state", error));
		}

		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				"Errors occurred during server shutdown",
			);
		}
	})();

	try {
		await serverStopPromise;
	} finally {
		serverStopPromise = null;
	}
}

export { AccountCredentialManager } from "./account-credential-manager";
export { createServerFetchHandler } from "./fetch-handler";
export { createStartupBanner } from "./startup-banner";

// Export for programmatic use
export default function startServer(
	options?: StartServerOptions,
): ServerHandle {
	// Return existing server if already running
	if (serverInstance) {
		return {
			port: serverInstance.port ?? NETWORK.DEFAULT_PORT,
			stop: () => stopServerRuntime(),
		};
	}

	const { port = NETWORK.DEFAULT_PORT, withDashboard = true } = options || {};

	if (withDashboard) {
		loadDashboardAssets();
	}

	const {
		config,
		dbOps,
		log,
		apiRouter,
		accountQuotaService,
		proxyContext,
		runtimeConfig,
		retentionCleanupJob,
	} = bootstrapRuntime(port, serverLog);

	runStartupMaintenance(dbOps);

	const fetchHandler = createServerFetchHandler({
		apiRouter,
		proxyContext,
		withDashboard,
	});

	// Main server
	serverInstance = serve({
		port: runtimeConfig.port,
		idleTimeout: NETWORK.IDLE_TIMEOUT_MAX, // Max allowed by Bun
		fetch(req, server) {
			return fetchHandler(req, server);
		},
		websocket: websocketProxyHandler,
	});
	activeAccountQuotaService = accountQuotaService;
	retentionCleanupJob.start();
	stopRetentionJob = () => retentionCleanupJob.stop();
	quotaRefreshJob = startQuotaRefreshJob(dbOps, accountQuotaService, log);
	const activePort = serverInstance.port ?? runtimeConfig.port;

	lifecycleLog.info(
		createStartupBanner({
			version: process.env.npm_package_version || "1.0.0",
			port: activePort,
			withDashboard,
			strategy: config.getStrategy(),
			providers: providerRegistry.listProviders(),
		}),
	);

	logInitialAccountStatus(log, dbOps);

	return {
		port: activePort,
		stop: () => stopServerRuntime(),
	};
}

// Graceful shutdown handler
async function handleGracefulShutdown(signal: string) {
	lifecycleLog.info(`Received ${signal}, shutting down gracefully`);
	try {
		await stopServerRuntime();
		lifecycleLog.info("Shutdown complete");
		process.exit(0);
	} catch (error) {
		lifecycleLog.error("Error during shutdown", error);
		process.exit(1);
	}
}

// Register signal handlers
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));

// Run server if this is the main entry point
if (import.meta.main) {
	startServer();
}
