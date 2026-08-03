export type ModelFamilyAlias = "anthropic" | "openai";

export type StrippedModel = {
	family: ModelFamilyAlias;
	model: string;
};

export function stripCompatibilityModelPrefix(
	model: unknown,
): StrippedModel | null {
	if (typeof model !== "string") {
		return null;
	}

	const trimmed = model.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) {
		return null;
	}

	const family = trimmed.slice(0, separator);
	const modelId = trimmed.slice(separator + 1).trim();
	if ((family !== "anthropic" && family !== "openai") || modelId.length === 0) {
		return null;
	}

	return {
		family,
		model: modelId,
	};
}

export function resolveCompatibilityModel(
	model: unknown,
	nativeFamily: ModelFamilyAlias,
): StrippedModel | null {
	if (typeof model !== "string") {
		return null;
	}

	const trimmed = model.trim();
	if (!trimmed) {
		return null;
	}

	return (
		stripCompatibilityModelPrefix(trimmed) ?? {
			family: nativeFamily,
			model: trimmed,
		}
	);
}

export function normalizeTrackedModel(model: unknown): string | undefined {
	if (typeof model !== "string") {
		return undefined;
	}

	const trimmed = model.trim();
	if (!trimmed) {
		return undefined;
	}

	return stripCompatibilityModelPrefix(trimmed)?.model ?? trimmed;
}

const MODEL_FIELD_RE = /"model"\s*:\s*"([^"]+)"/;

export function extractTrackedModelFromRequestBody(
	encodedBody: string | null,
): string | undefined {
	if (!encodedBody) {
		return undefined;
	}

	try {
		// The model field is always near the start of the JSON object.
		// Decode only the first 512 bytes and extract via regex to avoid
		// a full JSON.parse of potentially multi-MB request bodies.
		const slice = encodedBody.slice(0, 700);
		const decoded = Buffer.from(slice, "base64").toString("utf-8");
		const match = decoded.match(MODEL_FIELD_RE);
		return match ? normalizeTrackedModel(match[1]) : undefined;
	} catch {
		return undefined;
	}
}
