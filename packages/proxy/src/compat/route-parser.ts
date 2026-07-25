import type { AccountProvider } from "@ccflare/types";
import type { ModelFamilyAlias } from "./model-id";
import type { CompatibilityRouteKind } from "./types";

export const COMPAT_PROVIDER_ORDER: Record<
	ModelFamilyAlias,
	AccountProvider[]
> = {
	openai: ["codex", "openai"],
	anthropic: ["claude-code", "anthropic"],
};

export type ParsedCompatibilityRoute = {
	kind: CompatibilityRouteKind;
};

export function parseCompatibilityRoute(
	pathname: string,
): ParsedCompatibilityRoute | null {
	switch (pathname) {
		case "/v1/ccflare/anthropic/messages":
		case "/v1/ccflare/anthropic/v1/messages":
			return { kind: "anthropic-messages" };
		case "/v1/ccflare/openai/chat/completions":
			return { kind: "openai-chat-completions" };
		case "/v1/ccflare/openai/responses":
			return { kind: "openai-responses" };
		default:
			return null;
	}
}
