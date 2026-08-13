import type { DatabaseOperations } from "@ccflare/database";
import { errorResponse, jsonResponse, ServiceUnavailable } from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import type { CleanupResponse, MutationResult } from "@ccflare/types";
import type { RetentionCleanupScheduler } from "../types";

const log = new Logger("MaintenanceHandler");

export function createCleanupHandler(
	scheduler: RetentionCleanupScheduler | undefined,
) {
	return (): Response => {
		try {
			const status = scheduler?.runNow() ?? "unavailable";
			if (status === "unavailable") {
				throw ServiceUnavailable("Retention cleanup worker is unavailable");
			}
			const cleanupData: CleanupResponse = { status };
			const result: MutationResult<CleanupResponse> = {
				success: true,
				message:
					status === "accepted"
						? "Retention cleanup queued"
						: "Retention cleanup is already running",
				data: cleanupData,
			};
			return jsonResponse(result, 202);
		} catch (error) {
			log.error("Cleanup operation failed", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Cleanup operation failed"),
			);
		}
	};
}

export function createCompactHandler(dbOps: DatabaseOperations) {
	return (): Response => {
		try {
			dbOps.compact();
			const result: MutationResult = {
				success: true,
				message: "Database compacted successfully",
			};
			return jsonResponse(result);
		} catch (error) {
			log.error("Compaction operation failed", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Database compaction failed"),
			);
		}
	};
}
