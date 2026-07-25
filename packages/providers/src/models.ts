import { sanitizeQuotaData } from "./quota";
import type {
	ModelCatalogVersionResult,
	ProviderModelEntry,
	ProviderModelsReport,
	ProviderQuotaState,
} from "./types";

const MODELS_REQUEST_TIMEOUT_MS = 10_000;

export interface ModelCatalogVersionDefinition {
	clientVersion: string;
	url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize one upstream catalog entry to the ccflare wire shape. Entries
 * without a usable slug are dropped. Only curated, non-secret presentation
 * fields are kept; the upstream payload may carry arbitrary extra metadata.
 */
export function normalizeModelEntry(value: unknown): ProviderModelEntry | null {
	if (!isRecord(value) || typeof value.slug !== "string" || !value.slug) {
		return null;
	}

	const rawLevels = Array.isArray(value.supported_reasoning_levels)
		? value.supported_reasoning_levels
		: [];
	const supportedReasoningLevels = rawLevels
		.filter(
			(level): level is Record<string, unknown> & { effort: string } =>
				isRecord(level) && typeof level.effort === "string" && !!level.effort,
		)
		.map((level) => ({
			effort: level.effort,
			...(typeof level.description === "string"
				? { description: level.description }
				: {}),
		}));

	return {
		slug: value.slug,
		...(typeof value.display_name === "string"
			? { displayName: value.display_name }
			: {}),
		...(typeof value.description === "string"
			? { description: value.description }
			: {}),
		...(typeof value.default_reasoning_level === "string"
			? { defaultReasoningLevel: value.default_reasoning_level }
			: {}),
		supportedReasoningLevels,
		...(value.hidden === true ? { hidden: true } : {}),
	};
}

/**
 * Effective effort combos for a model. Models that only advertise a default
 * reasoning level count as that single combo; models with no level metadata
 * count as a bare slug-level combo.
 */
function comboKeys(model: ProviderModelEntry): string[] {
	const efforts = model.supportedReasoningLevels.map((level) => level.effort);
	if (efforts.length === 0 && model.defaultReasoningLevel) {
		efforts.push(model.defaultReasoningLevel);
	}
	if (efforts.length === 0) {
		return [model.slug];
	}
	return efforts.map((effort) => `${model.slug} ${effort}`);
}

/**
 * Remove every model+effort combo from `older` that `newer` also advertises.
 * Models unique to the older list pass through untouched; models present in
 * both keep only the effort levels the newer list does not offer, and are
 * dropped entirely when nothing unique remains.
 */
export function cullOverlappingCombos(
	newer: ProviderModelEntry[],
	older: ProviderModelEntry[],
): { models: ProviderModelEntry[]; culledCount: number } {
	const newerKeys = new Set(newer.flatMap(comboKeys));
	const newerSlugs = new Set(newer.map((model) => model.slug));

	const models: ProviderModelEntry[] = [];
	let culledCount = 0;

	for (const model of older) {
		if (!newerSlugs.has(model.slug)) {
			models.push(model);
			continue;
		}

		const levels =
			model.supportedReasoningLevels.length > 0
				? model.supportedReasoningLevels
				: model.defaultReasoningLevel
					? [{ effort: model.defaultReasoningLevel }]
					: [];

		if (levels.length === 0) {
			// Slug-only combo and the newer tier has the slug: fully culled.
			culledCount += 1;
			continue;
		}

		const keptLevels = levels.filter(
			(level) => !newerKeys.has(`${model.slug} ${level.effort}`),
		);
		culledCount += levels.length - keptLevels.length;
		if (keptLevels.length === 0) {
			continue;
		}
		models.push(
			model.supportedReasoningLevels.length > 0
				? { ...model, supportedReasoningLevels: keptLevels }
				: model,
		);
	}

	return { models, culledCount };
}

async function fetchOneVersion(
	definition: ModelCatalogVersionDefinition,
	headers: HeadersInit,
	fetchFn: typeof globalThis.fetch,
	secretValues: readonly string[],
): Promise<ModelCatalogVersionResult> {
	const base: ModelCatalogVersionResult = {
		clientVersion: definition.clientVersion,
		state: "failed",
		models: [],
	};

	let response: Response;
	try {
		response = await fetchFn(definition.url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(MODELS_REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown models request failure";
		return {
			...base,
			error: String(sanitizeQuotaData(message, secretValues)).slice(0, 500),
		};
	}

	base.status = response.status;
	const text = await response.text();
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		return { ...base, error: "Upstream returned a non-JSON models response" };
	}

	if (!response.ok) {
		return {
			...base,
			error: `Upstream models request failed with HTTP ${response.status}`,
		};
	}

	const rawModels =
		isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
	const models = rawModels
		.map(normalizeModelEntry)
		.filter((entry): entry is ProviderModelEntry => entry !== null);

	return {
		...base,
		state: "ok",
		etag: response.headers.get("etag") ?? undefined,
		models: sanitizeQuotaData(models, secretValues) as ProviderModelEntry[],
	};
}

function classifyState(
	versions: ModelCatalogVersionResult[],
): ProviderQuotaState {
	const okCount = versions.filter((version) => version.state === "ok").length;
	if (okCount === versions.length) {
		return "ok";
	}
	if (okCount === 0) {
		return "failed";
	}
	return "partial";
}

/**
 * Fetch every client-version catalog concurrently, then build a tiered
 * report: the newest version keeps its full list and each older version is
 * culled of the model+effort combos already advertised by newer tiers.
 * `hiddenModels` are appended to the newest successful tier when the remote
 * catalog does not advertise them at all.
 */
export async function collectModelCatalog(
	definitions: ModelCatalogVersionDefinition[],
	headersForVersion: (clientVersion: string) => HeadersInit,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
	secretValues: readonly string[] = [],
	hiddenModels: ProviderModelEntry[] = [],
): Promise<ProviderModelsReport> {
	const versions = await Promise.all(
		definitions.map((definition) =>
			fetchOneVersion(
				definition,
				headersForVersion(definition.clientVersion),
				fetchFn,
				secretValues,
			),
		),
	);

	const seen: ProviderModelEntry[] = [];
	for (const version of versions) {
		if (version.state !== "ok") {
			continue;
		}
		const { models, culledCount } = cullOverlappingCombos(seen, version.models);
		version.models = models;
		version.culledCount = culledCount;
		seen.push(...version.models);
	}

	const knownSlugs = new Set(seen.map((model) => model.slug));
	const firstOk = versions.find((version) => version.state === "ok");
	if (firstOk) {
		for (const hidden of hiddenModels) {
			if (!knownSlugs.has(hidden.slug)) {
				firstOk.models.push({ ...hidden, hidden: true });
				knownSlugs.add(hidden.slug);
			}
		}
	}

	return {
		state: classifyState(versions),
		collectedAt: new Date().toISOString(),
		versions,
	};
}
