// Export all types

// Export base provider class
export { BaseProvider } from "./base";
// Export providers
export * from "./models";
// Export OAuth utilities
export * from "./oauth";
export * from "./providers/index";
export * from "./quota";
export * from "./quota-normalization";
// Export registry functions
export {
	createProviderRegistry,
	getOAuthProvider,
	ProviderRegistry,
	registerProvider,
	registry as providerRegistry,
	resolveProvider,
} from "./registry";
export * from "./token-refresh";
export * from "./types";

import { AnthropicProvider } from "./providers/anthropic/provider";
import { ClaudeCodeProvider } from "./providers/claude-code/provider";
import { CodexProvider } from "./providers/codex/provider";
import { GrokProvider } from "./providers/grok/provider";
import { KimiProvider } from "./providers/kimi/provider";
import { OpenAIProvider } from "./providers/openai/provider";
// Auto-register built-in providers
import { registerProvider } from "./registry";

registerProvider(new AnthropicProvider());
registerProvider(new OpenAIProvider());
registerProvider(new ClaudeCodeProvider());
registerProvider(new CodexProvider());
registerProvider(new KimiProvider());
registerProvider(new GrokProvider());
