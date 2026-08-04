import type { AccountProvider } from "@ccflare/types";
import type {
	ProviderQuotaReport,
	ProviderQuotaWindow,
	ProviderQuotaWindowScope,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const PERCENT_KEYS = [
	"utilization",
	"used_percent",
	"usedPercent",
	"percentage",
	"percent",
] as const;
const USED_KEYS = ["used", "usage", "consumed"] as const;
const LIMIT_KEYS = ["limit", "total", "quota"] as const;
const RESET_KEYS = [
	"resets_at",
	"reset_at",
	"resetAt",
	"resetsAt",
	"end_time",
	"endTime",
] as const;
const RESET_AFTER_KEYS = [
	"reset_after_seconds",
	"resetAfterSeconds",
	"resets_after_seconds",
	"resetsAfterSeconds",
] as const;

function asRecord(value: unknown): UnknownRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: undefined;
}

function firstValue(
	records: readonly (UnknownRecord | undefined)[],
	keys: readonly string[],
): unknown {
	for (const record of records) {
		if (!record) continue;
		for (const key of keys) {
			if (record[key] !== undefined && record[key] !== null) {
				return record[key];
			}
		}
	}
	return undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	if (typeof value === "string" && value.trim() === "") return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slug(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replaceAll(/^-|-$/g, "") || "unknown"
	);
}

function displayName(value: string): string {
	return value
		.replaceAll(/[-_]+/g, " ")
		.replaceAll(/\b\w/g, (character) => character.toUpperCase());
}

function normalizePeriod(...values: unknown[]): string {
	for (const value of values) {
		const text = nonEmptyString(value)?.toLowerCase();
		if (!text) continue;
		if (/\b(5\s*h|5\s*hours?|five[ -]?hours?)\b/.test(text)) return "5h";
		if (/\b(7\s*d|7\s*days?|seven[ -]?days?|weekly|week)\b/.test(text)) {
			return "7d";
		}

		const duration = text.match(/\b(\d+)\s*(h(?:ours?)?|d(?:ays?)?)\b/);
		if (duration) {
			return `${duration[1]}${duration[2].startsWith("h") ? "h" : "d"}`;
		}

		const descriptive = slug(text.replaceAll(/\b(limit|quota|window)\b/g, ""));
		if (descriptive !== "unknown") return descriptive;
	}
	return "unknown";
}

function normalizeResetAt(value: unknown): string | undefined {
	const numeric = finiteNumber(value);
	let milliseconds: number | undefined;
	if (numeric !== undefined && numeric > 0) {
		milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	} else if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) milliseconds = parsed;
	}
	if (milliseconds === undefined) return undefined;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeRelativeResetAt(
	value: unknown,
	collectedAt: string,
): string | undefined {
	const seconds = nonNegativeNumber(value);
	const collectedAtMs = Date.parse(collectedAt);
	if (seconds === undefined || !Number.isFinite(collectedAtMs))
		return undefined;
	const resetAtMs = collectedAtMs + seconds * 1000;
	if (!Number.isFinite(resetAtMs)) return undefined;
	const resetAt = new Date(resetAtMs);
	return Number.isNaN(resetAt.getTime()) ? undefined : resetAt.toISOString();
}

interface WindowDefinition {
	id: string;
	label: string;
	period: string;
	scope: ProviderQuotaWindowScope;
	model?: string;
	collectedAt: string;
	valueRecords: readonly (UnknownRecord | undefined)[];
}

function buildWindow(
	definition: WindowDefinition,
): ProviderQuotaWindow | undefined {
	const used = nonNegativeNumber(
		firstValue(definition.valueRecords, USED_KEYS),
	);
	const limit = nonNegativeNumber(
		firstValue(definition.valueRecords, LIMIT_KEYS),
	);
	const explicitPercent = nonNegativeNumber(
		firstValue(definition.valueRecords, PERCENT_KEYS),
	);
	const calculatedPercent =
		used !== undefined && limit !== undefined && limit > 0
			? (used / limit) * 100
			: undefined;
	const percent = explicitPercent ?? calculatedPercent;
	if (percent === undefined) return undefined;

	const resetAt =
		normalizeResetAt(firstValue(definition.valueRecords, RESET_KEYS)) ??
		normalizeRelativeResetAt(
			firstValue(definition.valueRecords, RESET_AFTER_KEYS),
			definition.collectedAt,
		);
	return {
		id: definition.id,
		label: definition.label,
		period: definition.period,
		scope: definition.scope,
		usedPercent: Math.min(percent, 100),
		...(used !== undefined ? { used } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(resetAt ? { resetAt } : {}),
		...(definition.model ? { model: definition.model } : {}),
	};
}

function successfulUsageData(
	report: ProviderQuotaReport,
): UnknownRecord | undefined {
	const usage = report.sources.usage;
	if (!usage || usage.state !== "ok") return undefined;
	const root = asRecord(usage.data);
	if (!root) return undefined;
	const knownRootKeys = [
		"five_hour",
		"fiveHour",
		"seven_day",
		"sevenDay",
		"rate_limit",
		"rateLimit",
		"additional_rate_limits",
		"additionalRateLimits",
		"usage",
		"limits",
		"windows",
	];
	const isRecognizedRoot = knownRootKeys.some((key) => root[key] !== undefined);
	return !isRecognizedRoot ? (asRecord(root.data) ?? root) : root;
}

function addUnique(
	windows: ProviderQuotaWindow[],
	window: ProviderQuotaWindow | undefined,
): void {
	if (window && !windows.some((candidate) => candidate.id === window.id)) {
		windows.push(window);
	}
}

function normalizeClaudeCodeWindows(
	report: ProviderQuotaReport,
): ProviderQuotaWindow[] {
	const data = successfulUsageData(report);
	if (!data) return [];
	const windows: ProviderQuotaWindow[] = [];

	const addKnown = (
		aliases: readonly string[],
		id: string,
		label: string,
		period: string,
		scope: ProviderQuotaWindowScope = "account",
		model?: string,
	) => {
		for (const key of aliases) {
			const record = asRecord(data[key]);
			if (!record) continue;
			addUnique(
				windows,
				buildWindow({
					id,
					label,
					period,
					scope,
					model,
					collectedAt: report.collectedAt,
					valueRecords: [record],
				}),
			);
		}
	};

	addKnown(
		["five_hour", "fiveHour"],
		"claude-code:account:5h",
		"5-hour limit",
		"5h",
	);
	addKnown(
		["seven_day", "sevenDay"],
		"claude-code:account:7d",
		"Weekly limit",
		"7d",
	);
	addKnown(
		["seven_day_opus", "sevenDayOpus"],
		"claude-code:model:opus:7d",
		"Opus weekly limit",
		"7d",
		"model",
		"opus",
	);
	addKnown(
		["seven_day_sonnet", "sevenDaySonnet"],
		"claude-code:model:sonnet:7d",
		"Sonnet weekly limit",
		"7d",
		"model",
		"sonnet",
	);

	return windows;
}

function codexRateWindows(
	rateLimit: UnknownRecord,
	collectedAt: string,
	qualifier: string,
	labelPrefix: string,
	scope: ProviderQuotaWindowScope,
	model?: string,
): ProviderQuotaWindow[] {
	const windows: ProviderQuotaWindow[] = [];
	const definitions = [
		{
			aliases: ["primary_window", "primaryWindow", "five_hour", "fiveHour"],
			period: "5h",
			label: "5-hour limit",
		},
		{
			aliases: ["secondary_window", "secondaryWindow", "seven_day", "sevenDay"],
			period: "7d",
			label: "Weekly limit",
		},
	] as const;

	for (const definition of definitions) {
		const record = asRecord(firstValue([rateLimit], definition.aliases));
		if (!record) continue;
		addUnique(
			windows,
			buildWindow({
				id: `codex:${scope}:${slug(qualifier)}:${definition.period}`,
				label: labelPrefix
					? `${labelPrefix} ${definition.label.toLowerCase()}`
					: definition.label,
				period: definition.period,
				scope,
				model,
				collectedAt,
				valueRecords: [record],
			}),
		);
	}
	return windows;
}

function normalizeCodexWindows(
	report: ProviderQuotaReport,
): ProviderQuotaWindow[] {
	const data = successfulUsageData(report);
	if (!data) return [];
	const windows: ProviderQuotaWindow[] = [];
	const mainRateLimit = asRecord(
		firstValue([data], ["rate_limit", "rateLimit"]),
	);
	if (mainRateLimit) {
		windows.push(
			...codexRateWindows(
				mainRateLimit,
				report.collectedAt,
				"main",
				"",
				"account",
			),
		);
	}

	const additionalValue = firstValue(
		[data],
		["additional_rate_limits", "additionalRateLimits"],
	);
	const additionalEntries: Array<[string | undefined, unknown]> = Array.isArray(
		additionalValue,
	)
		? additionalValue.map((entry) => [undefined, entry])
		: Object.entries(asRecord(additionalValue) ?? {});

	for (const [mapKey, value] of additionalEntries) {
		const entry = asRecord(value);
		if (!entry) continue;
		const model = nonEmptyString(
			firstValue([entry], ["model", "model_name", "modelName"]),
		);
		const meter =
			nonEmptyString(
				firstValue(
					[entry],
					[
						"limit_name",
						"limitName",
						"metered_feature",
						"meteredFeature",
						"name",
					],
				),
			) ?? mapKey;
		if (!meter && !model) continue;
		const rateLimit =
			asRecord(firstValue([entry], ["rate_limit", "rateLimit"])) ?? entry;
		windows.push(
			...codexRateWindows(
				rateLimit,
				report.collectedAt,
				model ?? meter ?? "unknown",
				displayName(model ?? meter ?? "unknown"),
				model ? "model" : "meter",
				model,
			),
		);
	}

	return windows;
}

function normalizeKimiWindows(
	report: ProviderQuotaReport,
): ProviderQuotaWindow[] {
	const data = successfulUsageData(report);
	if (!data) return [];
	const windows: ProviderQuotaWindow[] = [];
	const summary = asRecord(data.usage);
	if (summary) {
		const label =
			nonEmptyString(firstValue([summary], ["name", "label"])) ??
			"Weekly limit";
		const period = normalizePeriod(summary.period, label, "weekly");
		addUnique(
			windows,
			buildWindow({
				id: `kimi:account:summary:${period}`,
				label,
				period,
				scope: "account",
				collectedAt: report.collectedAt,
				valueRecords: [summary],
			}),
		);
	}

	const limitsValue = firstValue([data], ["limits", "windows"]);
	const limitEntries: Array<[string | undefined, unknown]> = Array.isArray(
		limitsValue,
	)
		? limitsValue.map((entry) => [undefined, entry])
		: Object.entries(asRecord(limitsValue) ?? {});

	for (const [mapKey, value] of limitEntries) {
		const entry = asRecord(value);
		if (!entry) continue;
		const detail = asRecord(entry.detail) ?? entry;
		const timeWindow = asRecord(
			firstValue([entry, detail], ["window", "time_window", "timeWindow"]),
		);
		const model = nonEmptyString(
			firstValue([detail, entry], ["model", "model_name", "modelName"]),
		);
		const meter = nonEmptyString(
			firstValue([detail, entry], ["meter", "meter_name", "meterName"]),
		);
		const label =
			nonEmptyString(firstValue([detail, entry], ["name", "label"])) ??
			model ??
			meter ??
			mapKey ??
			"Quota window";
		const period = normalizePeriod(
			firstValue([detail, entry], ["period", "duration"]),
			label,
		);
		const scope: ProviderQuotaWindowScope = model
			? "model"
			: meter
				? "meter"
				: "account";
		addUnique(
			windows,
			buildWindow({
				id: `kimi:${scope}:${slug(model ?? meter ?? label)}:${period}`,
				label,
				period,
				scope,
				model,
				collectedAt: report.collectedAt,
				valueRecords: [detail, entry, timeWindow],
			}),
		);
	}

	return windows;
}

/**
 * Project successful provider-native quota data into stable windows without
 * changing or depending on the raw report. Unknown and malformed fields are
 * ignored independently so one bad window cannot hide its valid siblings.
 */
export function normalizeQuotaWindows(
	provider: AccountProvider,
	report: ProviderQuotaReport,
): ProviderQuotaWindow[] {
	switch (provider) {
		case "claude-code":
			return normalizeClaudeCodeWindows(report);
		case "codex":
			return normalizeCodexWindows(report);
		case "kimi":
			return normalizeKimiWindows(report);
		default:
			return [];
	}
}
