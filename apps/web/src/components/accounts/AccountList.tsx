import type { AccountResponse } from "@ccflare/api";
import { AccountListItem } from "./AccountListItem";

interface AccountListProps {
	accounts: AccountResponse[] | undefined;
	onPauseToggle: (account: AccountResponse) => void;
	onResetRateLimit: (accountId: string) => void;
	resettingRateLimitAccountId: string | null;
	onRemove: (account: AccountResponse) => void;
	onRename: (account: AccountResponse) => void;
}

export function AccountList({
	accounts,
	onPauseToggle,
	onResetRateLimit,
	resettingRateLimitAccountId,
	onRemove,
	onRename,
}: AccountListProps) {
	if (!accounts || accounts.length === 0) {
		return <p className="text-muted-foreground">No accounts configured</p>;
	}

	// Find the most recently used account
	const mostRecentAccountId = accounts.reduce(
		(mostRecent, account) => {
			if (!account.lastUsed) return mostRecent;
			if (!mostRecent) return account.id;

			const mostRecentAccount = accounts.find((a) => a.id === mostRecent);
			if (!mostRecentAccount?.lastUsed) return account.id;

			const mostRecentLastUsed = new Date(mostRecentAccount.lastUsed).getTime();
			const currentLastUsed = new Date(account.lastUsed).getTime();

			return currentLastUsed > mostRecentLastUsed ? account.id : mostRecent;
		},
		null as string | null,
	);

	return (
		<div className="space-y-2">
			{accounts.map((account) => (
				<AccountListItem
					key={account.id}
					account={account}
					isActive={account.id === mostRecentAccountId}
					onPauseToggle={onPauseToggle}
					onResetRateLimit={onResetRateLimit}
					isResettingRateLimit={resettingRateLimitAccountId === account.id}
					onRemove={onRemove}
					onRename={onRename}
				/>
			))}
		</div>
	);
}
