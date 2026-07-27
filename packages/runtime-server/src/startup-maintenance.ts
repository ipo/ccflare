import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import { Logger } from "@ccflare/logger";

export function runStartupMaintenance(
	config: Config,
	dbOps: DatabaseOperations,
): () => void {
	const log = new Logger("StartupMaintenance");

	try {
		const interrupted = dbOps.markInterruptedWebSocketRequests();
		if (interrupted > 0) {
			log.warn(
				`Marked ${interrupted} WebSocket request(s) interrupted after restart`,
			);
		}
	} catch (err) {
		log.error(`WebSocket startup reconciliation error: ${err}`);
	}

	try {
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		const { removedRequests, removedPayloads } = dbOps.cleanupOldRequests(
			payloadDays * 24 * 60 * 60 * 1000,
			requestDays * 24 * 60 * 60 * 1000,
		);
		log.info(
			`Startup cleanup removed ${removedRequests} requests and ${removedPayloads} payloads (payload=${payloadDays}d, requests=${requestDays}d)`,
		);
	} catch (err) {
		log.error(`Startup cleanup error: ${err}`);
	}

	// VACUUM remains available through the explicit maintenance endpoint. Do not
	// rewrite a potentially large transcript database on every startup.
	return () => {};
}
