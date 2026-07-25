import type { Account, RequestMeta } from "@ccflare/types";
import { isRateLimitExemptModel } from "../rate-limit-exemptions";
import type { ResolvedProxyContext } from "./proxy-types";

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
