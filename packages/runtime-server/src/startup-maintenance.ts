import type { DatabaseOperations } from "@ccflare/database";
import { Logger } from "@ccflare/logger";

export function runStartupMaintenance(dbOps: DatabaseOperations): void {
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
}
