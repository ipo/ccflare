import type { AccountProvider } from "@ccflare/types";
import type { ModelFamilyAlias } from "./model-id";
import type { CompatibilityRouteKind } from "./types";

export const COMPAT_PROVIDER_ORDER: Record<
	ModelFamilyAlias,
	AccountProvider[]
> = {
	openai: ["codex", "openai"],
	anthropic: ["claude-code", "anthropic"],
	kimi: ["kimi"],
};

export type ParsedCompatibilityRoute = {
	kind: CompatibilityRouteKind;
	nativeFamily: ModelFamilyAlias;
};

export function parseCompatibilityRoute(
	pathname: string,
): ParsedCompatibilityRoute | null {
	switch (pathname) {
		case "/v1/ccflare/anthropic/messages":
		case "/v1/ccflare/anthropic/v1/messages":
			return { kind: "anthropic-messages", nativeFamily: "anthropic" };
		case "/v1/ccflare/openai/chat/completions":
			return { kind: "openai-chat-completions", nativeFamily: "openai" };
		case "/v1/ccflare/openai/responses":
			return { kind: "openai-responses", nativeFamily: "openai" };
		default:
			return null;
	}
}
