import { describe, expect, it } from "bun:test";
import { resolveCompatibilityModel } from "./model-id";

type CatalogEntry = {
	slug: string;
	aliases?: string[];
	inherits?: string;
	visibility?: "list" | "hide" | "none";
	multi_agent_version?: "disabled" | "v1" | "v2" | null;
	context_window?: number;
	max_context_window?: number;
	input_modalities?: string[];
	default_reasoning_level?: string;
	supported_reasoning_levels?: Array<{ effort: string }>;
	[key: string]: unknown;
};

type CatalogOverlay = { models: CatalogEntry[] };

const catalogPath = new URL(
	"../../../../integrations/codex/models.json",
	import.meta.url,
);
const overlay = (await Bun.file(catalogPath).json()) as CatalogOverlay;

const openaiModels = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex-spark",
];
const anthropicModels = [
	"anthropic/claude-fable-5",
	"anthropic/claude-opus-5",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-sonnet-5",
	"anthropic/claude-haiku-4-5-20251001",
];
const kimiModels = [
	"kimi/k3",
	"kimi/k3-256k",
	"kimi/kimi-for-coding",
	"kimi/kimi-for-coding-highspeed",
];
const expectedPickerModels = [
	...openaiModels,
	...anthropicModels,
	...kimiModels,
];
const expectedAliases: Record<string, string[]> = {
	"gpt-5.6-sol": ["5.6-sol", "openai/gpt-5.6-sol"],
	"gpt-5.6-terra": ["5.6-terra", "openai/gpt-5.6-terra"],
	"gpt-5.6-luna": ["5.6-luna", "openai/gpt-5.6-luna"],
	"gpt-5.5": ["5.5", "openai/gpt-5.5"],
	"gpt-5.4": ["5.4", "openai/gpt-5.4"],
	"gpt-5.4-mini": ["5.4-mini", "openai/gpt-5.4-mini"],
	"gpt-5.3-codex-spark": ["5.3-spark", "openai/gpt-5.3-codex-spark"],
	"anthropic/claude-fable-5": ["fable-5"],
	"anthropic/claude-opus-5": ["opus-5"],
	"anthropic/claude-opus-4-8": ["opus-4.8"],
	"anthropic/claude-sonnet-5": ["sonnet-5"],
	"anthropic/claude-haiku-4-5-20251001": ["haiku-4.5"],
	"kimi/k3": ["k3"],
	"kimi/k3-256k": ["k3-256k"],
	"kimi/kimi-for-coding": ["kimi-2.7", "kimi-for-coding"],
	"kimi/kimi-for-coding-highspeed": [
		"kimi-2.7-fast",
		"kimi-for-coding-highspeed",
	],
};

function entry(slug: string): CatalogEntry {
	const found = overlay.models.find((candidate) => candidate.slug === slug);
	if (!found) throw new Error(`Missing catalog entry for ${slug}`);
	return found;
}

function efforts(slug: string): string[] {
	return (
		entry(slug).supported_reasoning_levels?.map(({ effort }) => effort) ?? []
	);
}

describe("Codex catalog overlay", () => {
	it("contains the canonical inventory without OpenAI picker duplicates", () => {
		const slugs = overlay.models.map(({ slug }) => slug);
		expect(new Set(slugs).size).toBe(slugs.length);
		expect(slugs.filter((slug) => slug.startsWith("openai/"))).toEqual([]);
		expect(Object.keys(expectedAliases)).toEqual(expectedPickerModels);
		for (const slug of [
			...anthropicModels,
			...kimiModels,
			"gpt-5.3-codex-spark",
		]) {
			expect(entry(slug).inherits).toBe("gpt-5.6-sol");
		}
	});

	it("publishes complete ordered aliases without duplicates or collisions", () => {
		const canonicalSlugs = new Set(
			overlay.models.map(({ slug }) => slug.toLowerCase()),
		);
		const aliasOwners = new Map<string, string>();

		for (const slug of expectedPickerModels) {
			const aliases = entry(slug).aliases ?? [];
			expect(aliases).toEqual(expectedAliases[slug]);
			expect(new Set(aliases.map((alias) => alias.toLowerCase())).size).toBe(
				aliases.length,
			);

			for (const alias of aliases) {
				const normalized = alias.toLowerCase();
				expect(canonicalSlugs.has(normalized)).toBe(false);
				expect(aliasOwners.has(normalized)).toBe(false);
				aliasOwners.set(normalized, slug);
			}
		}
	});

	it("resolves representative source limits, modalities, and effort defaults", () => {
		expect(entry("gpt-5.3-codex-spark")).toMatchObject({
			context_window: 128000,
			max_context_window: 128000,
			input_modalities: ["text"],
		});
		expect(entry("anthropic/claude-opus-5")).toMatchObject({
			context_window: 1000000,
			max_context_window: 1000000,
			input_modalities: ["text", "image"],
		});
		expect(entry("anthropic/claude-haiku-4-5-20251001")).toMatchObject({
			context_window: 200000,
			max_context_window: 200000,
		});
		expect(entry("kimi/k3")).toMatchObject({
			context_window: 1048576,
			max_context_window: 1048576,
			default_reasoning_level: "high",
		});
		expect(efforts("kimi/k3")).toEqual(["low", "high", "max"]);
		expect(efforts("anthropic/claude-fable-5")).not.toContain("none");
		expect(entry("kimi/kimi-for-coding")).toMatchObject({
			default_reasoning_level: "on",
			context_window: 262144,
			max_context_window: 262144,
		});
		expect(efforts("kimi/kimi-for-coding")).toEqual(["none", "on"]);
	});

	it("clears Codex-only metadata for every external model", () => {
		for (const slug of [...anthropicModels, ...kimiModels]) {
			expect(entry(slug)).toMatchObject({
				support_verbosity: false,
				comp_hash: null,
				use_responses_lite: true,
				tool_mode: "direct",
				supports_search_tool: false,
				supports_parallel_tool_calls: true,
				experimental_supported_tools: [],
			});
		}
	});

	it("keeps each supported model visible once and hides unavailable bundled models", () => {
		const bundled = new Map<string, "list" | "hide" | "none">([
			["gpt-5.6-sol", "list"],
			["gpt-5.6-terra", "list"],
			["gpt-5.6-luna", "list"],
			["gpt-5.5", "list"],
			["gpt-5.4", "hide"],
			["gpt-5.4-mini", "hide"],
			["gpt-5.2", "list"],
			["codex-auto-review", "hide"],
		]);
		for (const model of overlay.models) {
			bundled.set(model.slug, model.visibility ?? "list");
		}
		const picker = [...bundled]
			.filter(([, visibility]) => visibility === "list")
			.map(([slug]) => slug);

		expect(picker).toEqual(expectedPickerModels);
		expect(entry("gpt-5.2").visibility).toBe("none");
		expect(entry("codex-auto-review").visibility).toBe("none");
	});

	it("marks every picker model as V2 compatible without changing hidden models", () => {
		for (const slug of expectedPickerModels) {
			expect(entry(slug).multi_agent_version).toBe("v2");
		}

		for (const slug of ["gpt-5.2", "codex-auto-review"]) {
			expect(entry(slug)).toMatchObject({ visibility: "none" });
			expect(entry(slug)).not.toHaveProperty("multi_agent_version");
		}
	});

	it("retains canonical model slugs while routing every family through one provider", () => {
		expect(resolveCompatibilityModel("gpt-5.6-sol", "openai")).toEqual({
			family: "openai",
			model: "gpt-5.6-sol",
		});
		expect(
			resolveCompatibilityModel("anthropic/claude-sonnet-5", "openai"),
		).toEqual({ family: "anthropic", model: "claude-sonnet-5" });
		expect(resolveCompatibilityModel("kimi/k3", "openai")).toEqual({
			family: "kimi",
			model: "k3",
		});
	});
});
