import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../types";

export type ResponsesToolIdentity =
	| { kind: "function"; name: string; namespace?: string }
	| { kind: "custom"; name: string; namespace?: string };

export type ResponsesToolProjection = {
	tools: JsonRecord[];
	toolChoice?: JsonRecord;
	reverseByWireName: Map<string, ResponsesToolIdentity>;
};

export class ResponsesToolProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResponsesToolProjectionError";
	}
}

function requireName(value: unknown, context: string): string {
	if (typeof value !== "string" || !value) {
		throw new ResponsesToolProjectionError(
			`${context} requires a non-empty name`,
		);
	}
	return value;
}

function wireName(identity: ResponsesToolIdentity): string {
	return `${identity.namespace ?? ""}${identity.name}`;
}

function collectResponsesTools(input: JsonRecord): unknown[] {
	const tools = Array.isArray(input.tools) ? [...input.tools] : [];
	const inputItems = typeof input.input === "string" ? [] : input.input;
	for (const item of Array.isArray(inputItems) ? inputItems : []) {
		if (
			isRecord(item) &&
			item.type === "additional_tools" &&
			Array.isArray(item.tools)
		) {
			tools.push(...item.tools);
		}
	}
	return tools;
}

function anthropicFunctionTool(
	tool: JsonRecord,
	identity: ResponsesToolIdentity,
): JsonRecord {
	return {
		name: wireName(identity),
		description: typeof tool.description === "string" ? tool.description : "",
		input_schema: isRecord(tool.parameters) ? tool.parameters : {},
	};
}

function anthropicCustomTool(
	tool: JsonRecord,
	identity: ResponsesToolIdentity,
): JsonRecord {
	return {
		name: wireName(identity),
		description: typeof tool.description === "string" ? tool.description : "",
		input_schema: {
			type: "object",
			properties: { input: { type: "string" } },
			required: ["input"],
			additionalProperties: false,
		},
	};
}

function registerTool(
	projection: ResponsesToolProjection,
	tool: JsonRecord,
	identity: ResponsesToolIdentity,
): void {
	const name = wireName(identity);
	const previous = projection.reverseByWireName.get(name);
	if (previous) {
		throw new ResponsesToolProjectionError(
			`Responses tool wire-name collision for '${name}'; rename the conflicting ordinary, namespace, or custom tool`,
		);
	}
	projection.reverseByWireName.set(name, identity);
	projection.tools.push(
		identity.kind === "custom"
			? anthropicCustomTool(tool, identity)
			: anthropicFunctionTool(tool, identity),
	);
}

function projectDeclaration(
	projection: ResponsesToolProjection,
	declaration: unknown,
	index: number,
): void {
	if (!isRecord(declaration)) {
		throw new ResponsesToolProjectionError(
			`Responses tool at index ${index} must be an object`,
		);
	}
	const type =
		typeof declaration.type === "string" ? declaration.type : "function";
	if (type === "function") {
		registerTool(projection, declaration, {
			kind: "function",
			name: requireName(
				declaration.name,
				`Responses function tool at index ${index}`,
			),
		});
		return;
	}
	if (type === "custom") {
		registerTool(projection, declaration, {
			kind: "custom",
			name: requireName(
				declaration.name,
				`Responses custom tool at index ${index}`,
			),
		});
		return;
	}
	if (type === "namespace") {
		const namespace = requireName(
			declaration.name,
			`Responses namespace tool at index ${index}`,
		);
		if (!Array.isArray(declaration.tools)) {
			throw new ResponsesToolProjectionError(
				`Responses namespace tool '${namespace}' requires a tools array`,
			);
		}
		for (const [nestedIndex, nested] of declaration.tools.entries()) {
			if (!isRecord(nested) || (nested.type ?? "function") !== "function") {
				const nestedType = isRecord(nested)
					? String(nested.type ?? "unknown")
					: "invalid";
				throw new ResponsesToolProjectionError(
					`Unsupported Responses namespace tool type '${nestedType}' in '${namespace}'; only function tools can be projected`,
				);
			}
			registerTool(projection, nested, {
				kind: "function",
				name: requireName(
					nested.name,
					`Responses namespace function at ${index}.${nestedIndex}`,
				),
				namespace,
			});
		}
		return;
	}
	throw new ResponsesToolProjectionError(
		`Unsupported Responses hosted tool type '${type}' for Anthropic compatibility; remove it or use a function, namespace, or custom tool`,
	);
}

function findChoiceIdentity(
	projection: ResponsesToolProjection,
	toolChoice: JsonRecord,
): ResponsesToolIdentity {
	const name = requireName(toolChoice.name, "Responses tool_choice");
	const namespace =
		typeof toolChoice.namespace === "string" ? toolChoice.namespace : undefined;
	const expectedKind = toolChoice.type === "custom" ? "custom" : "function";
	const nameOnWire = wireName({ kind: expectedKind, name, namespace });
	const identity = projection.reverseByWireName.get(nameOnWire);
	if (
		!identity ||
		identity.kind !== expectedKind ||
		identity.name !== name ||
		identity.namespace !== namespace
	) {
		throw new ResponsesToolProjectionError(
			`Responses tool_choice references undeclared ${expectedKind} tool '${nameOnWire}'`,
		);
	}
	return identity;
}

function projectToolChoice(
	projection: ResponsesToolProjection,
	toolChoice: unknown,
): JsonRecord | undefined {
	if (typeof toolChoice === "string") {
		if (toolChoice === "required") return { type: "any" };
		if (toolChoice === "auto") return { type: "auto" };
		if (toolChoice === "none") return { type: "none" };
		throw new ResponsesToolProjectionError(
			`Unsupported Responses tool_choice '${toolChoice}' for Anthropic compatibility`,
		);
	}
	if (!isRecord(toolChoice)) {
		throw new ResponsesToolProjectionError(
			"Responses tool_choice must be 'auto', 'required', 'none', or a declared function/custom tool",
		);
	}
	if (toolChoice.type !== "function" && toolChoice.type !== "custom") {
		throw new ResponsesToolProjectionError(
			`Unsupported Responses tool_choice type '${String(toolChoice.type)}' for Anthropic compatibility`,
		);
	}
	const identity = findChoiceIdentity(projection, toolChoice);
	return { type: "tool", name: wireName(identity) };
}

export function projectResponsesTools(
	input: JsonRecord,
): ResponsesToolProjection {
	const projection: ResponsesToolProjection = {
		tools: [],
		reverseByWireName: new Map(),
	};
	for (const [index, declaration] of collectResponsesTools(input).entries()) {
		projectDeclaration(projection, declaration, index);
	}
	if (input.tool_choice != null) {
		projection.toolChoice = projectToolChoice(projection, input.tool_choice);
	}
	return projection;
}

export function reverseResponsesToolCall(
	wireToolName: string,
	input: unknown,
	reverseByWireName: ReadonlyMap<string, ResponsesToolIdentity>,
): JsonRecord {
	const identity = reverseByWireName.get(wireToolName) ?? {
		kind: "function" as const,
		name: wireToolName,
	};
	if (identity.kind === "custom") {
		return {
			type: "custom_tool_call",
			name: identity.name,
			...(identity.namespace ? { namespace: identity.namespace } : {}),
			input:
				isRecord(input) && typeof input.input === "string"
					? input.input
					: typeof input === "string"
						? input
						: "",
		};
	}
	return {
		type: "function_call",
		name: identity.name,
		...(identity.namespace ? { namespace: identity.namespace } : {}),
		arguments: JSON.stringify(input ?? {}),
	};
}
