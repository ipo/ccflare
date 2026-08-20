import type { Account, RequestMeta } from "@ccflare/types";
import { isRateLimitExemptModel } from "../rate-limit-exemptions";
import type { ResolvedProxyContext } from "./proxy-types";

export type AccountAvailability =
	| { kind: "managed_candidates"; accounts: Account[] }
	| { kind: "no_configured_accounts" }
	| { kind: "cooling_down"; retryAt: number }
	| { kind: "unavailable" };

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @param model - The requested model, when known. Models whose quota is
 *   metered separately (see rate-limit-exemptions) may use accounts that
 *   are rate-limited on the main meter.
 * @returns Array of ordered accounts
 */
export function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
	model?: string,
): Account[] {
	const includeRateLimited = isRateLimitExemptModel(ctx.providerName, model);
	const providerAccounts = ctx.dbOps.getAvailableAccountsByProvider(
		ctx.providerName,
		{ includeRateLimited },
	);
	return ctx.strategy.select(providerAccounts, meta, { includeRateLimited });
}

/**
 * Selects accounts for a request based on the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @param model - The requested model, when known
 * @returns Array of selected accounts
 */
export function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
	model?: string,
): Account[] {
	return getOrderedAccounts(meta, ctx, model);
}

/**
 * Classifies native routing from both persisted provider accounts and the
 * strategy's current candidates. An empty strategy result never implies that
 * unauthenticated passthrough is safe.
 */
export function getAccountAvailability(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
	model?: string,
): AccountAvailability {
	const configuredAccounts = ctx.dbOps.getAccountsByProvider(ctx.providerName);
	if (configuredAccounts.length === 0) {
		return { kind: "no_configured_accounts" };
	}

	const accounts = selectAccountsForRequest(meta, ctx, model);
	if (accounts.length > 0) {
		return { kind: "managed_candidates", accounts };
	}

	const now = Date.now();
	const activeAccounts = configuredAccounts.filter(
		(account) => !account.paused,
	);
	const cooldowns = activeAccounts
		.map((account) => account.rate_limited_until)
		.filter((retryAt): retryAt is number => retryAt !== null && retryAt > now);
	if (activeAccounts.length > 0 && cooldowns.length === activeAccounts.length) {
		return { kind: "cooling_down", retryAt: Math.min(...cooldowns) };
	}

	return { kind: "unavailable" };
}
