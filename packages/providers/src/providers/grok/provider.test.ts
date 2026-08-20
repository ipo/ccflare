import { afterEach, describe, expect, it } from "bun:test";
import { createOAuthAccount, originalFetch } from "../../test-helpers";
import { GrokProvider } from "./provider";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("GrokProvider", () => {
	it("specializes native Responses transport and preserves caller Grok IDs", () => {
		const provider = new GrokProvider();
		const account = createOAuthAccount("grok", { oauth_subject: "user-123" });
		const headers = provider.prepareHeaders(
			new Headers({
				"x-grok-conv-id": "conv-caller",
				"x-grok-req-id": "req-caller",
				"x-grok-session-id": "session-caller",
				"x-grok-agent-id": "agent-caller",
				"x-grok-turn-idx": "7",
				"x-grok-deployment-id": "deployment-caller",
			}),
			account,
		);
		expect(provider.buildUrl("/responses", "", account)).toBe(
			"https://cli-chat-proxy.grok.com/v1/responses",
		);
		expect(() => provider.buildUrl("/chat/completions", "", account)).toThrow(
			"only the native /responses endpoint",
		);
		expect(headers.get("authorization")).toBe("Bearer grok-access-token");
		expect(headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
		expect(headers.get("x-authenticateresponse")).toBe("authenticate-response");
		expect(headers.get("x-grok-user-id")).toBe("user-123");
		expect(headers.get("x-grok-client-version")).toBe("1.0.6");
		expect(headers.get("x-grok-client-identifier")).toBe("grok-shell");
		expect(headers.get("x-grok-client-mode")).toBe("interactive");
		expect(headers.get("user-agent")).toMatch(
			/^grok-shell\/1\.0\.6 \([^;]+; [^)]+\)$/,
		);
		expect(headers.get("x-grok-conv-id")).toBe("conv-caller");
		expect(headers.get("x-grok-req-id")).toBe("req-caller");
		expect(headers.get("x-grok-session-id")).toBe("session-caller");
		expect(headers.get("x-grok-agent-id")).toBe("agent-caller");
		expect(headers.get("x-grok-turn-idx")).toBe("7");
		expect(headers.get("x-grok-deployment-id")).toBe("deployment-caller");
		expect(provider.supportsWebSocket()).toBe(false);
	});

	it("normalizes preferred credits and explicitly enabled on-demand headroom while sanitizing", async () => {
		const provider = new GrokProvider();
		const account = createOAuthAccount("grok", { oauth_subject: "user-123" });
		const report = await provider.fetchQuota(account, (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			expect(request.url).toBe(
				"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			);
			expect(request.headers.get("x-userid")).toBe("user-123");
			expect(request.headers.get("x-grok-client-version")).toBe("1.0.6");
			expect(request.headers.get("x-grok-client-mode")).toBe("interactive");
			return Response.json({
				config: {
					creditUsagePercent: 100,
					currentPeriod: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						end: "2026-08-27T00:00:00Z",
					},
					onDemandCap: { val: 1000 },
					onDemandUsed: { val: 250 },
					prepaidBalance: { val: 75 },
					isUnifiedBillingUser: true,
					history: [{ totalUsed: { val: 5 } }],
					accessToken: "leak",
				},
				onDemandEnabled: true,
				subscriptionTier: "SuperGrok",
			});
		}) as unknown as typeof fetch);
		expect(report.state).toBe("ok");
		expect(report.windows.map((window) => window.id)).toEqual([
			"grok:included",
			"grok:on-demand",
		]);
		expect(report.sources.credits.data).toEqual({
			config: {
				creditUsagePercent: 100,
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					end: "2026-08-27T00:00:00Z",
				},
				onDemandCap: { val: 1000 },
				onDemandUsed: { val: 250 },
				prepaidBalance: { val: 75 },
				isUnifiedBillingUser: true,
				history: [{ totalUsed: { val: 5 } }],
				accessToken: "[REDACTED]",
			},
			onDemandEnabled: true,
			subscriptionTier: "SuperGrok",
		});
	});

	it("normalizes exhausted credits as a successful known quota report", async () => {
		const provider = new GrokProvider();
		const account = createOAuthAccount("grok");
		const exhausted = await provider.fetchQuota(account, (async () =>
			Response.json({
				config: {
					creditUsagePercent: 100,
					currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
					prepaidBalance: { val: 0 },
					history: [{ includedUsed: { val: 100 } }],
					isUnifiedBillingUser: false,
				},
				onDemandEnabled: false,
				subscriptionTier: "SuperGrok",
			})) as unknown as typeof fetch);

		expect(exhausted).toMatchObject({
			state: "ok",
			windows: [{ id: "grok:included", usedPercent: 100 }],
			sources: {
				credits: {
					state: "ok",
					status: 200,
					data: {
						config: {
							prepaidBalance: { val: 0 },
							history: [{ includedUsed: { val: 100 } }],
							isUnifiedBillingUser: false,
						},
						onDemandEnabled: false,
						subscriptionTier: "SuperGrok",
					},
				},
			},
		});
	});

	it("normalizes legacy quota and fails closed for malformed shapes", async () => {
		const provider = new GrokProvider();
		const account = createOAuthAccount("grok");
		const legacy = await provider.fetchQuota(account, (async () =>
			Response.json({
				config: {
					monthlyLimit: { val: 100 },
					used: { val: 20 },
					billingPeriodStart: "start",
					billingPeriodEnd: "end",
				},
			})) as unknown as typeof fetch);
		expect(legacy.windows[0]).toMatchObject({
			used: 20,
			limit: 100,
			usedPercent: 20,
			resetAt: "end",
		});
		const malformed = await provider.fetchQuota(account, (async () =>
			Response.json({ config: {} })) as unknown as typeof fetch);
		expect(malformed).toMatchObject({ state: "failed", windows: [] });
	});

	it("uses only the live /models catalog and returns no fallback on failure", async () => {
		const provider = new GrokProvider();
		const account = createOAuthAccount("grok", {
			oauth_subject: "models-user",
		});
		const ok = await provider.fetchModels(account, (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			expect(request.url).toBe("https://cli-chat-proxy.grok.com/v1/models");
			expect(request.url).not.toContain("models-v2");
			expect(request.headers.get("x-userid")).toBe("models-user");
			expect(request.headers.get("x-grok-client-version")).toBe("1.0.6");
			expect(request.headers.get("x-grok-client-mode")).toBe("interactive");
			return Response.json({
				data: [
					{
						model: "grok-live",
						name: "Grok Live",
						reasoning_effort: "high",
						reasoning_efforts: [{ value: "high", description: "Careful" }],
					},
				],
			});
		}) as unknown as typeof fetch);
		expect(ok.versions[0].models).toEqual([
			{
				slug: "grok-live",
				displayName: "Grok Live",
				defaultReasoningLevel: "high",
				supportedReasoningLevels: [{ effort: "high", description: "Careful" }],
			},
		]);
		const failed = await provider.fetchModels(
			account,
			(async () =>
				new Response("no", { status: 503 })) as unknown as typeof fetch,
		);
		expect(failed).toMatchObject({
			state: "failed",
			versions: [{ models: [] }],
		});
	});

	it("normalizes the official camelCase reasoning fields", async () => {
		const provider = new GrokProvider();
		const account = createOAuthAccount("grok", {
			oauth_subject: "models-user",
		});
		const report = await provider.fetchModels(account, (async () =>
			Response.json({
				data: [
					{
						model: "grok-official",
						reasoningEffort: "medium",
						reasoningEfforts: [
							{ value: "low", description: "Fast" },
							{ value: "medium", description: "Balanced" },
						],
					},
				],
			})) as unknown as typeof fetch);

		expect(report.versions[0].models).toEqual([
			{
				slug: "grok-official",
				defaultReasoningLevel: "medium",
				supportedReasoningLevels: [
					{ effort: "low", description: "Fast" },
					{ effort: "medium", description: "Balanced" },
				],
			},
		]);
	});
});
