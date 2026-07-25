import type { AccountProvider } from "@ccflare/types";

/**
 * Models whose quota is metered separately from the account's main rate
 * limit. OpenAI's Codex quota API exposes these via `additional_rate_limits`
 * (e.g. `gpt-5.3-codex-spark` meters as `codex_bengalfox` while every other
 * Codex model shares the main weekly meter).
 *
 * ccflare tracks rate limits per account, not per meter, so an account-level
 * mark set by main-meter exhaustion must not block separately metered
 * models — and a separately metered model's own 429 must not poison the
 * account-level mark for the main meter. Both directions key off this
 * predicate.
 *
 * Patterns are suffixes so future Spark generations (e.g.
 * `gpt-5.4-codex-spark`) are covered without code changes.
 */
const EXEMPT_MODEL_SUFFIXES: ReadonlyMap<AccountProvider, readonly string[]> =
	new Map([["codex", ["-codex-spark"]]]);

export function isRateLimitExemptModel(
	provider: AccountProvider,
	model: string | undefined,
): boolean {
	if (!model) {
		return false;
	}
	const suffixes = EXEMPT_MODEL_SUFFIXES.get(provider);
	if (!suffixes) {
		return false;
	}
	return suffixes.some((suffix) => model.endsWith(suffix));
}
