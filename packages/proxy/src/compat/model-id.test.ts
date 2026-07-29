import { describe, expect, it } from "bun:test";
import {
	extractTrackedModelFromRequestBody,
	normalizeTrackedModel,
	resolveCompatibilityModel,
	stripCompatibilityModelPrefix,
} from "./model-id";
import { COMPAT_PROVIDER_ORDER, parseCompatibilityRoute } from "./route-parser";

describe("compat model id helpers", () => {
	it("strips compatibility family prefixes when present", () => {
		expect(stripCompatibilityModelPrefix("openai/gpt-5.4")).toEqual({
			family: "openai",
			model: "gpt-5.4",
		});
		expect(stripCompatibilityModelPrefix("anthropic/claude-sonnet-4")).toEqual({
			family: "anthropic",
			model: "claude-sonnet-4",
		});
		expect(stripCompatibilityModelPrefix("kimi/k3")).toEqual({
			family: "kimi",
			model: "k3",
		});
	});

	it("uses the route family only for unprefixed models", () => {
		expect(resolveCompatibilityModel("gpt-5.4", "openai")).toEqual({
			family: "openai",
			model: "gpt-5.4",
		});
		expect(resolveCompatibilityModel("claude-sonnet-5", "anthropic")).toEqual({
			family: "anthropic",
			model: "claude-sonnet-5",
		});
		expect(resolveCompatibilityModel("kimi/k3", "openai")).toEqual({
			family: "kimi",
			model: "k3",
		});
	});

	it("normalizes tracked models without changing non-compat ids", () => {
		expect(normalizeTrackedModel(" openai/gpt-4o-mini ")).toBe("gpt-4o-mini");
		expect(normalizeTrackedModel("gpt-4o-mini")).toBe("gpt-4o-mini");
		expect(normalizeTrackedModel("")).toBeUndefined();
	});

	it("extracts a normalized model from encoded request bodies", () => {
		const encoded = Buffer.from(
			JSON.stringify({ model: "anthropic/claude-opus-4.1" }),
		).toString("base64");

		expect(extractTrackedModelFromRequestBody(encoded)).toBe("claude-opus-4.1");
	});

	it("declares the compatibility family routing matrix", () => {
		expect(COMPAT_PROVIDER_ORDER).toEqual({
			openai: ["codex", "openai"],
			anthropic: ["claude-code", "anthropic"],
			kimi: ["kimi"],
		});
		expect(parseCompatibilityRoute("/v1/ccflare/openai/responses")).toEqual({
			kind: "openai-responses",
			nativeFamily: "openai",
		});
		expect(parseCompatibilityRoute("/v1/ccflare/anthropic/messages")).toEqual({
			kind: "anthropic-messages",
			nativeFamily: "anthropic",
		});
	});
});
