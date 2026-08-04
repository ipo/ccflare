import { afterEach, describe, expect, it } from "bun:test";
import { api } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("request detail client", () => {
	it("fetches one exact encoded request id", async () => {
		const urls: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				urls.push(String(input));
				return new Response(
					JSON.stringify({
						id: "id/with space",
						request: { headers: {}, body: null },
						response: null,
						meta: {
							trace: { timestamp: 1 },
							account: { id: null },
							transport: { pending: true },
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const detail = await api.getRequestDetail("id/with space");

		expect(detail.id).toBe("id/with space");
		expect(urls).toEqual(["/api/requests/id%2Fwith%20space/detail"]);
	});
});

describe("account quota client", () => {
	it("uses encoded account-specific quota and reset routes", async () => {
		const requests: Array<{ url: string; method: string }> = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({
					url: String(input),
					method: init?.method ?? "GET",
				});
				return Response.json({
					account: { id: "id/with space", name: "work", provider: "codex" },
					state: "ok",
					collectedAt: "2026-08-04T16:00:00.000Z",
					windows: [],
					sources: {},
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		await api.getAccountQuota("id/with space");
		await api.resetAccountRateLimit("id/with space");

		expect(requests).toEqual([
			{ url: "/api/accounts/id%2Fwith%20space/quota", method: "GET" },
			{
				url: "/api/accounts/id%2Fwith%20space/rate-limit/reset",
				method: "POST",
			},
		]);
	});
});
