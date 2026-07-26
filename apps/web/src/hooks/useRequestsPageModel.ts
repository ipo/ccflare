import type { AccountResponse } from "@ccflare/api";
import {
	parseRequestStreamEvent,
	type RequestPayload,
	type RequestSummary,
} from "@ccflare/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { REFRESH_INTERVALS } from "../constants";
import { queryKeys } from "../lib/query-keys";

interface RequestsCache {
	requests: RequestPayload[];
	summaries: Map<string, RequestSummary>;
}

function upsertRequest(
	requests: RequestPayload[],
	id: string,
	entry: RequestPayload,
	limit: number,
): RequestPayload[] {
	const idx = requests.findIndex((r) => r.id === id);
	return idx >= 0
		? requests.map((r, i) => (i === idx ? entry : r))
		: [entry, ...requests].slice(0, limit);
}

/**
 * Page-model hook for the Requests page.
 *
 * Owns:
 *  - initial fetch (polling as reconciliation, not primary)
 *  - SSE stream as primary freshness source
 *  - stable Map-based cache shape
 *  - account-name enrichment via SSE start events
 *
 * Components receive shaped data and call actions. No transport logic leaks.
 */
export function useRequestsPageModel(limit = 200, sessionId?: string) {
	const queryClient = useQueryClient();
	const [accountFilter, setAccountFilter] = useState<string>("all");
	const [dateFrom, setDateFrom] = useState<string>("");
	const [dateTo, setDateTo] = useState<string>("");
	const [statusCodeFilters, setStatusCodeFilters] = useState<Set<string>>(
		new Set(),
	);

	// -- Base query: fetch + normalize into stable shape --
	const {
		data,
		isLoading: loading,
		error,
		refetch,
	} = useQuery<RequestsCache>({
		queryKey: queryKeys.requests(limit),
		queryFn: async (): Promise<RequestsCache> => {
			const [detail, summary] = await Promise.all([
				api.getRequestsDetail(limit),
				api.getRequestsSummary(limit),
			]);
			// Always return a Map -- this is the stable shape.
			const summaries = new Map<string, RequestSummary>();
			for (const s of summary) {
				summaries.set(s.id, s);
			}
			return { requests: detail, summaries };
		},
		// Polling is a reconciliation path, not the primary source.
		// SSE handles real-time freshness.
		refetchInterval: REFRESH_INTERVALS.fast,
	});

	// -- SSE stream: patches the stable cache --
	useEffect(() => {
		let es: EventSource | null = null;
		let isDisposed = false;
		let retries = 0;
		let reconnectTimeout: NodeJS.Timeout | null = null;

		const connect = () => {
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
				reconnectTimeout = null;
			}

			es = new EventSource("/api/requests/stream");

			es.addEventListener("open", () => {
				retries = 0;
			});

			es.addEventListener("message", (ev) => {
				const evt = parseRequestStreamEvent(JSON.parse(ev.data));
				if (!evt) return;

				queryClient.setQueryData(
					queryKeys.requests(limit),
					(current: RequestsCache | undefined) => {
						if (!current) return current;

						const { requests, summaries } = current;

						if (evt.type === "ingress") {
							// If we already have data for this request, skip the placeholder
							if (requests.some((r) => r.id === evt.id)) {
								return current;
							}

							const placeholder: RequestPayload = {
								id: evt.id,
								request: { headers: {}, body: null },
								response: null,
								meta: {
									trace: {
										timestamp: evt.timestamp,
										path: evt.path,
										method: evt.method,
										clientSessionId: evt.clientSessionId ?? null,
									},
									account: {
										id: null,
									},
									transport: {
										success: false,
										pending: true,
									},
								},
							};

							return {
								requests: [placeholder, ...requests].slice(0, limit),
								summaries,
							};
						}

						if (evt.type === "start") {
							// Look up account name from cached accounts
							const accounts = queryClient.getQueryData<AccountResponse[]>(
								queryKeys.accounts(),
							);
							const account = accounts?.find((a) => a.id === evt.accountId);

							const placeholder: RequestPayload = {
								id: evt.id,
								request: { headers: {}, body: null },
								response: {
									status: evt.statusCode,
									headers: {},
									body: null,
								},
								meta: {
									trace: {
										timestamp: evt.timestamp,
										path: evt.path,
										method: evt.method,
										clientSessionId: evt.clientSessionId ?? null,
									},
									account: {
										id: evt.accountId,
										name: account?.name,
									},
									transport: {
										success: false,
										pending: true,
									},
								},
							};

							return {
								requests: upsertRequest(requests, evt.id, placeholder, limit),
								summaries,
							};
						}

						if (evt.type === "payload") {
							return {
								requests: upsertRequest(
									requests,
									evt.payload.id,
									evt.payload,
									limit,
								),
								summaries,
							};
						}

						// "summary" event
						const newSummaries = new Map(summaries);
						newSummaries.set(evt.payload.id, evt.payload);

						// Clear pending status on the matching request
						const reqIdx = requests.findIndex((r) => r.id === evt.payload.id);
						if (reqIdx < 0) {
							return { requests, summaries: newSummaries };
						}

						const newRequests = requests.map((r, i) => {
							if (i !== reqIdx) return r;
							return {
								...r,
								meta: {
									...r.meta,
									transport: {
										...r.meta.transport,
										pending: false,
										success: evt.payload.success === true,
									},
								},
							};
						});

						return { requests: newRequests, summaries: newSummaries };
					},
				);
			});

			es.addEventListener("error", () => {
				if (isDisposed) return;
				if (es) {
					es.close();
					es = null;
				}
				const delay = Math.min(1000 * 2 ** retries, 30000);
				retries++;
				reconnectTimeout = setTimeout(connect, delay);
			});
		};

		connect();

		return () => {
			isDisposed = true;
			if (reconnectTimeout) clearTimeout(reconnectTimeout);
			if (es) es.close();
		};
	}, [limit, queryClient]);

	const allRequests = data?.requests ?? [];
	const summaries = data?.summaries ?? new Map<string, RequestSummary>();
	const uniqueAccounts = Array.from(
		new Set(
			allRequests
				.map(
					(request) =>
						request.meta?.account?.name || request.meta?.account?.id || null,
				)
				.filter(Boolean),
		),
	).sort();
	const uniqueStatusCodes = Array.from(
		new Set(
			allRequests
				.map((request) => request.response?.status)
				.filter((status): status is number => status !== undefined),
		),
	).sort((left, right) => left - right);
	const requests = allRequests.filter((request) => {
		if (sessionId && request.meta?.trace?.clientSessionId !== sessionId) {
			return false;
		}

		if (accountFilter !== "all") {
			const requestAccount =
				request.meta?.account?.name || request.meta?.account?.id;
			if (requestAccount !== accountFilter) {
				return false;
			}
		}

		if (
			statusCodeFilters.size > 0 &&
			request.response?.status !== undefined &&
			!statusCodeFilters.has(request.response.status.toString())
		) {
			return false;
		}

		const requestDate = new Date(request.meta.trace.timestamp);
		if (dateFrom) {
			const fromDate = new Date(dateFrom);
			fromDate.setHours(0, 0, 0, 0);
			if (requestDate < fromDate) {
				return false;
			}
		}

		if (dateTo) {
			const toDate = new Date(dateTo);
			toDate.setHours(23, 59, 59, 999);
			if (requestDate > toDate) {
				return false;
			}
		}

		return true;
	});

	function applyDatePreset(preset: "1h" | "24h" | "7d" | "30d") {
		const now = new Date();
		const nextDateTo = now.toISOString().slice(0, 16);

		switch (preset) {
			case "1h": {
				const fromDate = new Date(now.getTime() - 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				break;
			}
			case "24h": {
				const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				break;
			}
			case "7d": {
				const fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				break;
			}
			case "30d": {
				const fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				break;
			}
		}

		setDateTo(nextDateTo);
	}

	function toggleStatusCode(code: string) {
		setStatusCodeFilters((previous) => {
			const next = new Set(previous);
			if (next.has(code)) {
				next.delete(code);
			} else {
				next.add(code);
			}
			return next;
		});
	}

	function clearFilters() {
		setAccountFilter("all");
		setDateFrom("");
		setDateTo("");
		setStatusCodeFilters(new Set());
	}

	return {
		requests,
		allRequests,
		summaries,
		accountFilter,
		setAccountFilter,
		dateFrom,
		setDateFrom,
		dateTo,
		setDateTo,
		statusCodeFilters,
		toggleStatusCode,
		clearFilters,
		applyDatePreset,
		uniqueAccounts,
		uniqueStatusCodes,
		hasActiveFilters:
			accountFilter !== "all" ||
			dateFrom !== "" ||
			dateTo !== "" ||
			statusCodeFilters.size > 0,
		loading,
		error,
		refetch,
	};
}
