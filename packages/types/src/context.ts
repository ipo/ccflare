import type { Account } from "./account";
import type { RequestMeta } from "./api";
import type { StrategyStore } from "./strategy";

// Load balancing strategy interface
export interface LoadBalancingStrategy {
	/**
	 * Return a filtered & ordered list of candidate accounts.
	 * Accounts that are rate-limited should be filtered out, unless
	 * `options.includeRateLimited` is set for models whose quota is
	 * metered separately from the account-level rate-limit mark.
	 * The first account in the list should be tried first.
	 */
	select(
		accounts: Account[],
		meta: RequestMeta,
		options?: { includeRateLimited?: boolean },
	): Account[];

	/**
	 * Optional initialization method to inject dependencies
	 * Used for strategies that need access to a StrategyStore
	 */
	initialize?(store: StrategyStore): void;
}
