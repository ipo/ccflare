import type {
	ProviderQuotaReport,
	ProviderQuotaState,
	QuotaSourceResult,
} from "./types";

const QUOTA_REQUEST_TIMEOUT_MS = 15_000;
const REDACTED_VALUE = "[REDACTED]";
const SECRET_FIELD_NAMES = new Set([
	"accesstoken",
	"apikey",
	"authorization",
	"bearertoken",
	"clientsecret",
	"credentials",
	"idtoken",
	"oauthtoken",
	"password",
	"refreshtoken",
	"secret",
	"token",
]);

export interface QuotaSourceDefinition {
	name: string;
	url: string;
}

function normalizeFieldName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_]/g, "");
}

/**
 * Recursively redact credential-shaped fields before provider payloads cross
 * the management API boundary. Quota fields such as `token_count` remain
 * intact because only exact secret field names are redacted.
 */
export function sanitizeQuotaData(
	value: unknown,
	secretValues: readonly string[] = [],
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeQuotaData(entry, secretValues));
	}

	if (typeof value === "string") {
		return secretValues
			.filter((secret) => secret.length >= 8)
			.reduce(
				(sanitized, secret) => sanitized.replaceAll(secret, REDACTED_VALUE),
				value,
			);
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			SECRET_FIELD_NAMES.has(normalizeFieldName(key))
				? REDACTED_VALUE
				: sanitizeQuotaData(entry, secretValues),
		]),
	);
}

function classifyQuotaState(
	sources: Record<string, QuotaSourceResult>,
): ProviderQuotaState {
	const sourceResults = Object.values(sources);
	const successfulSources = sourceResults.filter(
		(source) => source.state === "ok",
	).length;

	if (successfulSources === sourceResults.length) {
		return "ok";
	}
	if (successfulSources === 0) {
		return "failed";
	}
	return "partial";
}

async function parseJsonResponse(
	response: Response,
	secretValues: readonly string[],
): Promise<
	| { parsed: true; data: unknown }
	| {
			parsed: false;
	  }
> {
	const text = await response.text();
	if (!text) {
		return { parsed: true, data: null };
	}

	try {
		return {
			parsed: true,
			data: sanitizeQuotaData(JSON.parse(text), secretValues),
		};
	} catch {
		return { parsed: false };
	}
}

async function fetchQuotaSource(
	definition: QuotaSourceDefinition,
	headers: HeadersInit,
	fetchFn: typeof globalThis.fetch,
	secretValues: readonly string[],
): Promise<[string, QuotaSourceResult]> {
	try {
		const response = await fetchFn(definition.url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS),
		});
		const parsed = await parseJsonResponse(response, secretValues);

		if (!parsed.parsed) {
			return [
				definition.name,
				{
					state: "failed",
					status: response.status,
					error: "Upstream returned a non-JSON quota response",
				},
			];
		}

		if (!response.ok) {
			return [
				definition.name,
				{
					state: "failed",
					status: response.status,
					data: parsed.data,
					error: `Upstream quota request failed with HTTP ${response.status}`,
				},
			];
		}

		return [
			definition.name,
			{
				state: "ok",
				status: response.status,
				data: parsed.data,
			},
		];
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown quota request failure";
		return [
			definition.name,
			{
				state: "failed",
				error: String(sanitizeQuotaData(message, secretValues)).slice(0, 500),
			},
		];
	}
}

/**
 * Fetch all independent quota sources concurrently and retain partial results.
 */
export async function collectQuotaSources(
	definitions: QuotaSourceDefinition[],
	headers: HeadersInit,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
	secretValues: readonly string[] = [],
): Promise<ProviderQuotaReport> {
	const entries = await Promise.all(
		definitions.map((definition) =>
			fetchQuotaSource(definition, headers, fetchFn, secretValues),
		),
	);
	const sources = Object.fromEntries(entries);

	return {
		state: classifyQuotaState(sources),
		collectedAt: new Date().toISOString(),
		sources,
	};
}
