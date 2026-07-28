import type { DatabaseOperations, RequestDetailRow } from "@ccflare/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import {
	isAccountProvider,
	isHttpMethod,
	parseRequestPayload,
	type RequestPayload,
} from "@ccflare/types";
import {
	enrichRequestPayload,
	serializeRequestResponse,
} from "../serializers/request";
import { createWebSocketTranscriptExportResponse } from "./websocket-transcript";

const log = new Logger("RequestsHandler");

function parsePayloadRows(
	rows: Array<{ id: string; json: string; account_name: string | null }>,
) {
	return rows.flatMap((r) => {
		try {
			const data = parseRequestPayload({
				id: r.id,
				...JSON.parse(r.json),
			});
			if (!data) {
				log.warn(`Skipping malformed request payload ${r.id}`);
				return [];
			}

			return [
				enrichRequestPayload(
					data.id === r.id ? data : { ...data, id: r.id },
					r.account_name ?? null,
				),
			];
		} catch {
			log.warn(`Skipping unparsable request payload ${r.id}`);
			return [];
		}
	});
}

function parseDetailRows(rows: RequestDetailRow[]): RequestPayload[] {
	return rows.flatMap((row) => {
		if (!isHttpMethod(row.method) || !isAccountProvider(row.provider)) {
			return [];
		}
		if (row.payload_json) {
			try {
				const payload = parseRequestPayload({
					id: row.id,
					...JSON.parse(row.payload_json),
				});
				if (payload) {
					return [enrichRequestPayload(payload, row.account_name)];
				}
			} catch {
				log.warn(`Falling back to summary payload for ${row.id}`);
			}
		}

		const payload: RequestPayload = {
			id: row.id,
			request: { headers: {}, body: null },
			response:
				row.status_code === null
					? null
					: { status: row.status_code, headers: {}, body: null },
			...(row.error_message ? { error: row.error_message } : {}),
			meta: {
				trace: {
					timestamp: row.timestamp,
					method: row.method,
					path: row.path,
					provider: row.provider,
					upstreamPath: row.upstream_path,
					responseId: row.response_id,
					previousResponseId: row.previous_response_id,
					responseChainId: row.response_chain_id,
					clientSessionId: row.client_session_id,
				},
				account: { id: row.account_used, name: row.account_name },
				transport: {
					success: row.success === 1,
					pending: row.success === null,
					retry: row.failover_attempts,
					isStream: row.method === "WS",
					ttftMs: row.ttft_ms,
					proxyOverheadMs: row.proxy_overhead_ms,
					upstreamTtfbMs: row.upstream_ttfb_ms,
					streamingDurationMs: row.streaming_duration_ms,
				},
			},
		};
		return [payload];
	});
}

/**
 * Create a requests summary handler (existing functionality)
 */
export function createRequestsSummaryHandler(dbOps: DatabaseOperations) {
	return (limit: number = 50): Response => {
		try {
			return jsonResponse(
				dbOps.listRequestsWithAccountNames(limit).map(serializeRequestResponse),
			);
		} catch (error) {
			log.error("Failed to load request summaries", error);
			return errorResponse(
				InternalServerError("Failed to load request summaries"),
			);
		}
	};
}

/**
 * Create a detailed requests handler with full payload data
 */
export function createRequestsDetailHandler(dbOps: DatabaseOperations) {
	return (limit = 100): Response => {
		try {
			return jsonResponse(parseDetailRows(dbOps.listRequestDetailRows(limit)));
		} catch (error) {
			log.error("Failed to load request details", error);
			return errorResponse(
				InternalServerError("Failed to load request details"),
			);
		}
	};
}

export function createRequestsConversationHandler(dbOps: DatabaseOperations) {
	return (requestIdentifier: string, incomingRequest?: Request): Response => {
		try {
			const request =
				dbOps.getRequestWithAccountName(requestIdentifier) ??
				dbOps.getLatestRequestWithAccountNameByClientSessionId(
					requestIdentifier,
				);
			if (!request) {
				return errorResponse(NotFound("Request conversation not found"));
			}
			const requestId = request.id;
			if (request.method === "WS") {
				return createWebSocketTranscriptExportResponse(
					dbOps,
					requestId,
					request.success === null,
					incomingRequest?.signal,
				);
			}

			const rows = dbOps.listResponseChainPayloadsWithAccountNames(requestId);
			if (rows.length === 0) {
				return errorResponse(NotFound("Request conversation not found"));
			}

			return jsonResponse(parsePayloadRows(rows));
		} catch (error) {
			log.error("Failed to load request conversation", error);
			return errorResponse(
				InternalServerError("Failed to load request conversation"),
			);
		}
	};
}
