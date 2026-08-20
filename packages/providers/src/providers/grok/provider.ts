import { type Account, isRecord } from "@ccflare/types";
import { sanitizeQuotaData } from "../../quota";
import type {
	ProviderModelEntry,
	ProviderModelsReport,
	ProviderQuotaReport,
	TokenRefreshResult,
} from "../../types";
import { OpenAIProvider } from "../openai/provider";
import { GROK_CLIENT_VERSION } from "./constants";
import {
	GROK_OAUTH_CLIENT_ID,
	GROK_OAUTH_ISSUER,
	GrokOAuthProvider,
} from "./oauth";

export { GROK_CLIENT_VERSION } from "./constants";

const CLIENT_IDENTIFIER = "grok-shell";
const CLIENT_MODE = "interactive";

function officialPlatform(): { os: string; arch: string } {
	return {
		os: process.platform === "darwin" ? "macos" : process.platform,
		arch:
			process.arch === "arm64"
				? "aarch64"
				: process.arch === "x64"
					? "x86_64"
					: process.arch,
	};
}

function requireIdentity(account: Account): string {
	if (!account.access_token || !account.oauth_subject)
		throw new Error("Grok account is missing verified OAuth identity");
	return account.oauth_subject;
}

function applyClientHeaders(
	headers: Headers,
	account: Account,
	identityHeader: "x-userid" | "x-grok-user-id",
): Headers {
	const subject = requireIdentity(account);
	headers.set("authorization", `Bearer ${account.access_token}`);
	headers.set("X-XAI-Token-Auth", "xai-grok-cli");
	headers.set("x-authenticateresponse", "authenticate-response");
	headers.set(identityHeader, subject);
	headers.set("x-grok-client-version", GROK_CLIENT_VERSION);
	headers.set("x-grok-client-identifier", CLIENT_IDENTIFIER);
	headers.set("x-grok-client-mode", CLIENT_MODE);
	const platform = officialPlatform();
	headers.set(
		"user-agent",
		`grok-shell/${GROK_CLIENT_VERSION} (${platform.os}; ${platform.arch})`,
	);
	return headers;
}

function numberAt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

export class GrokProvider extends OpenAIProvider {
	name = "grok";
	defaultBaseUrl = "https://cli-chat-proxy.grok.com/v1";
	private oauth = new GrokOAuthProvider();

	buildUrl(upstreamPath: string, query: string, account?: Account): string {
		if (upstreamPath !== "/responses") {
			throw new Error("Grok supports only the native /responses endpoint");
		}
		return super.buildUrl(upstreamPath, query, account);
	}

	supportsOAuth(): boolean {
		return true;
	}
	getOAuthProvider(): GrokOAuthProvider {
		return this.oauth;
	}
	supportsWebSocket(): boolean {
		return false;
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const prepared = super.prepareHeaders(headers, null);
		prepared.delete("x-api-key");
		if (!account) return prepared;
		return applyClientHeaders(prepared, account, "x-grok-user-id");
	}

	async refreshToken(
		account: Account,
		_clientId: string,
		signal?: AbortSignal,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token)
			throw new Error("Grok refresh token is missing");
		const discoveryResponse = await fetch(
			`${GROK_OAUTH_ISSUER}/.well-known/openid-configuration`,
			{ signal },
		);
		if (!discoveryResponse.ok)
			throw new Error(
				`Grok OIDC discovery failed with HTTP ${discoveryResponse.status}`,
			);
		const metadata: unknown = await discoveryResponse.json();
		if (
			!isRecord(metadata) ||
			metadata.issuer !== GROK_OAUTH_ISSUER ||
			typeof metadata.token_endpoint !== "string"
		)
			throw new Error("Grok OIDC discovery response is invalid");
		const response = await fetch(metadata.token_endpoint, {
			method: "POST",
			signal,
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: account.refresh_token,
				client_id: GROK_OAUTH_CLIENT_ID,
			}),
		});
		if (!response.ok)
			throw new Error(`Grok token refresh failed with HTTP ${response.status}`);
		const value: unknown = await response.json();
		if (
			!isRecord(value) ||
			typeof value.access_token !== "string" ||
			typeof value.expires_in !== "number"
		)
			throw new Error("Grok token refresh response is invalid");
		return {
			accessToken: value.access_token,
			refreshToken:
				typeof value.refresh_token === "string"
					? value.refresh_token
					: account.refresh_token,
			expiresAt: Date.now() + value.expires_in * 1000,
		};
	}

	async fetchQuota(
		account: Account,
		fetchFn: typeof fetch = fetch,
	): Promise<ProviderQuotaReport> {
		const collectedAt = new Date().toISOString();
		try {
			const headers = applyClientHeaders(
				new Headers({ accept: "application/json" }),
				account,
				"x-userid",
			);
			const response = await fetchFn(
				`${(account.base_url ?? this.defaultBaseUrl).replace(/\/+$/, "")}/billing?format=credits`,
				{ headers },
			);
			if (!response.ok)
				throw new Error(
					`Grok billing request failed with HTTP ${response.status}`,
				);
			const raw: unknown = await response.json();
			if (!isRecord(raw) || !isRecord(raw.config))
				throw new Error("Grok billing response has no usable config");
			const config = raw.config;
			let usedPercent = numberAt(config.creditUsagePercent);
			let used: number | undefined;
			let limit: number | undefined;
			let period = "current period";
			let resetAt: string | undefined;
			if (usedPercent !== undefined && isRecord(config.currentPeriod)) {
				if (typeof config.currentPeriod.type === "string")
					period = config.currentPeriod.type
						.replace("USAGE_PERIOD_TYPE_", "")
						.toLowerCase();
				if (typeof config.currentPeriod.end === "string")
					resetAt = config.currentPeriod.end;
			} else {
				limit = isRecord(config.monthlyLimit)
					? numberAt(config.monthlyLimit.val)
					: undefined;
				used = isRecord(config.used) ? numberAt(config.used.val) : undefined;
				if (limit === undefined || used === undefined || limit <= 0)
					throw new Error("Grok billing response has an unknown quota shape");
				usedPercent = Math.min(100, (used / limit) * 100);
				period = "monthly";
				if (typeof config.billingPeriodEnd === "string")
					resetAt = config.billingPeriodEnd;
			}
			if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100)
				throw new Error("Grok billing response has invalid credit usage");
			const windows = [
				{
					id: "grok:included",
					label: "Included credits",
					period,
					scope: "account" as const,
					usedPercent,
					...(used !== undefined && { used }),
					...(limit !== undefined && { limit }),
					...(resetAt && { resetAt }),
				},
			];
			const onDemandCap = isRecord(config.onDemandCap)
				? numberAt(config.onDemandCap.val)
				: undefined;
			const onDemandUsed = isRecord(config.onDemandUsed)
				? numberAt(config.onDemandUsed.val)
				: undefined;
			if (
				onDemandCap !== undefined &&
				onDemandUsed !== undefined &&
				onDemandCap > 0
			)
				windows.push({
					id: "grok:on-demand",
					label: "On-demand credits",
					period,
					scope: "account",
					usedPercent: Math.min(100, (onDemandUsed / onDemandCap) * 100),
					used: onDemandUsed,
					limit: onDemandCap,
					...(resetAt && { resetAt }),
				});
			return {
				state: "ok",
				collectedAt,
				windows,
				sources: {
					credits: {
						state: "ok",
						status: response.status,
						data: sanitizeQuotaData(raw, [
							account.access_token ?? "",
							account.refresh_token ?? "",
						]),
					},
				},
			};
		} catch (error) {
			return {
				state: "failed",
				collectedAt,
				windows: [],
				sources: {
					credits: {
						state: "failed",
						error:
							error instanceof Error
								? error.message
								: "Grok quota request failed",
					},
				},
			};
		}
	}

	async fetchModels(
		account: Account,
		fetchFn: typeof fetch = fetch,
	): Promise<ProviderModelsReport> {
		const collectedAt = new Date().toISOString();
		try {
			const headers = applyClientHeaders(
				new Headers({ accept: "application/json" }),
				account,
				"x-userid",
			);
			const response = await fetchFn(
				`${(account.base_url ?? this.defaultBaseUrl).replace(/\/+$/, "")}/models`,
				{ headers },
			);
			if (!response.ok)
				throw new Error(
					`Grok models request failed with HTTP ${response.status}`,
				);
			const raw: unknown = await response.json();
			if (!isRecord(raw) || !Array.isArray(raw.data))
				throw new Error("Grok models response is invalid");
			const models: ProviderModelEntry[] = raw.data.flatMap(
				(entry): ProviderModelEntry[] => {
					if (!isRecord(entry)) return [];
					const slug =
						typeof entry.model === "string"
							? entry.model
							: typeof entry.id === "string"
								? entry.id
								: undefined;
					if (!slug) return [];
					const rawEfforts = Array.isArray(entry.reasoningEfforts)
						? entry.reasoningEfforts
						: Array.isArray(entry.reasoning_efforts)
							? entry.reasoning_efforts
							: [];
					const efforts = rawEfforts.flatMap((effort) =>
						isRecord(effort) && typeof effort.value === "string"
							? [
									{
										effort: effort.value,
										...(typeof effort.description === "string" && {
											description: effort.description,
										}),
									},
								]
							: [],
					);
					const defaultEffort =
						typeof entry.reasoningEffort === "string"
							? entry.reasoningEffort
							: typeof entry.reasoning_effort === "string"
								? entry.reasoning_effort
								: undefined;
					return [
						{
							slug,
							...(typeof entry.name === "string" && {
								displayName: entry.name,
							}),
							...(typeof entry.description === "string" && {
								description: entry.description,
							}),
							...(defaultEffort && {
								defaultReasoningLevel: defaultEffort,
							}),
							supportedReasoningLevels: efforts,
						},
					];
				},
			);
			return {
				state: "ok",
				collectedAt,
				versions: [
					{
						clientVersion: GROK_CLIENT_VERSION,
						state: "ok",
						status: response.status,
						etag: response.headers.get("etag") ?? undefined,
						models,
					},
				],
			};
		} catch (error) {
			return {
				state: "failed",
				collectedAt,
				versions: [
					{
						clientVersion: GROK_CLIENT_VERSION,
						state: "failed",
						error:
							error instanceof Error
								? error.message
								: "Grok models request failed",
						models: [],
					},
				],
			};
		}
	}
}
