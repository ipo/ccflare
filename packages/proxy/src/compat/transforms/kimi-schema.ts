import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../types";

function clone(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clone);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, clone(child)]),
	);
}

function resolvePointer(root: JsonRecord, ref: string): unknown {
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const rawPart of ref.slice(2).split("/")) {
		const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isRecord(current) || !(part in current)) return undefined;
		current = current[part];
	}
	return current;
}

function dereference(
	value: unknown,
	root: JsonRecord,
	resolving: Set<string>,
): unknown {
	if (Array.isArray(value)) {
		return value.map((child) => dereference(child, root, resolving));
	}
	if (!isRecord(value)) return value;

	if (typeof value.$ref === "string") {
		const target = resolvePointer(root, value.$ref);
		if (target !== undefined && !resolving.has(value.$ref)) {
			resolving.add(value.$ref);
			const resolved = dereference(target, root, resolving);
			resolving.delete(value.$ref);
			if (isRecord(resolved)) {
				const siblings = Object.fromEntries(
					Object.entries(value)
						.filter(([key]) => key !== "$ref")
						.map(([key, child]) => [key, dereference(child, root, resolving)]),
				);
				return { ...resolved, ...siblings };
			}
			return resolved;
		}
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			dereference(child, root, resolving),
		]),
	);
}

function valueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value === "object" ? "object" : typeof value;
}

const SCHEMA_MAP_KEYS = [
	"$defs",
	"definitions",
	"dependencies",
	"dependentSchemas",
	"patternProperties",
	"properties",
] as const;
const SCHEMA_KEYS = [
	"additionalItems",
	"additionalProperties",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
] as const;
const SCHEMA_ARRAY_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

function normalizeChildren(schema: JsonRecord): void {
	for (const key of SCHEMA_MAP_KEYS) {
		const children = schema[key];
		if (isRecord(children)) {
			for (const child of Object.values(children)) normalizeNode(child, true);
		}
	}
	for (const key of SCHEMA_KEYS) {
		const child = schema[key];
		if (key === "items" && Array.isArray(child)) {
			for (const item of child) normalizeNode(item, true);
		} else {
			normalizeNode(child, true);
		}
	}
	for (const key of SCHEMA_ARRAY_KEYS) {
		const children = schema[key];
		if (Array.isArray(children)) {
			for (const child of children) normalizeNode(child, true);
		}
	}
}

function normalizeNode(value: unknown, completeType: boolean): void {
	if (!isRecord(value)) return;
	const hasCombinator = ["allOf", "anyOf", "oneOf", "not", "$ref"].some(
		(key) => key in value,
	);
	if (completeType && value.type === undefined && !hasCombinator) {
		if (Array.isArray(value.enum) && value.enum.length > 0) {
			const types = [...new Set(value.enum.map(valueType))];
			if (types.length === 1) value.type = types[0];
		} else if ("const" in value) {
			value.type = valueType(value.const);
		} else if (
			"properties" in value ||
			"dependencies" in value ||
			"required" in value ||
			"additionalProperties" in value
		) {
			value.type = "object";
		} else if ("items" in value || "prefixItems" in value) {
			value.type = "array";
		} else {
			value.type = "string";
		}
	}
	normalizeChildren(value);
}

export function normalizeKimiToolSchema(schema: JsonRecord): JsonRecord {
	const copied = clone(schema) as JsonRecord;
	const normalized = dereference(copied, copied, new Set()) as JsonRecord;
	normalizeNode(normalized, false);
	if (!JSON.stringify(normalized).includes('"$ref":"#/$defs/')) {
		delete normalized.$defs;
	}
	if (!JSON.stringify(normalized).includes('"$ref":"#/definitions/')) {
		delete normalized.definitions;
	}
	return normalized;
}
