import type { AccountResponse } from "@ccflare/api";
import { parseRequestStreamEvent } from "@ccflare/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { REFRESH_INTERVALS } from "../constants";
import { queryKeys } from "../lib/query-keys";
import {
	applyRequestStreamEvent,
	filterRequestList,
	type RequestListItem,
	reconcileRequestList,
} from "../lib/request-list-model";

/**
 * Page-model hook for the Requests page.
 *
 * Owns:
 *  - initial fetch (polling as reconciliation, not primary)
 *  - SSE stream as primary freshness source
 *  - metadata-only list cache
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
	} = useQuery<RequestListItem[]>({
		queryKey: queryKeys.requests(limit),
		queryFn: async (): Promise<RequestListItem[]> => {
			const summaries = await api.getRequestsSummary(limit);
			const current = queryClient.getQueryData<RequestListItem[]>(
				queryKeys.requests(limit),
			);
			return reconcileRequestList(summaries, current, limit);
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

				queryClient.setQueryData<RequestListItem[]>(
					queryKeys.requests(limit),
					(current) => {
						if (!current) return current;
						let enrichedEvent = evt;
						if (evt.type === "start" && evt.accountName == null) {
							// Look up account name from cached accounts
							const accounts = queryClient.getQueryData<AccountResponse[]>(
								queryKeys.accounts(),
							);
							const account = accounts?.find((a) => a.id === evt.accountId);

							enrichedEvent = { ...evt, accountName: account?.name ?? null };
						}
						return applyRequestStreamEvent(current, enrichedEvent, limit);
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

	const allRequests = data ?? [];
	const uniqueAccounts = Array.from(
		new Set(
			allRequests
				.map((request) => request.accountName || request.accountId || null)
				.filter(Boolean),
		),
	).sort();
	const uniqueStatusCodes = Array.from(
		new Set(
			allRequests
				.map((request) => request.statusCode)
				.filter((status): status is number => status !== null),
		),
	).sort((left, right) => left - right);
	const requests = filterRequestList(allRequests, {
		sessionId,
		account: accountFilter,
		dateFrom,
		dateTo,
		statusCodes: statusCodeFilters,
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
