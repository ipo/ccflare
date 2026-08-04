import type { AccountResponse } from "@ccflare/api";
import { AccountPresenter } from "@ccflare/ui";
import {
	AlertCircle,
	CheckCircle,
	Edit2,
	Pause,
	Play,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { ProviderBadge } from "../ProviderBadge";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { QuotaSnapshot } from "./QuotaSnapshot";
import { RateLimitProgress } from "./RateLimitProgress";

function getAuthMethodLabel(authMethod: string): string {
	switch (authMethod) {
		case "oauth":
			return "OAuth";
		case "api_key":
			return "API Key";
		default:
			return authMethod
				.split("_")
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(" ");
	}
}

interface AccountListItemProps {
	account: AccountResponse;
	isActive?: boolean;
	onPauseToggle: (account: AccountResponse) => void;
	onResetRateLimit: (accountId: string) => void;
	isResettingRateLimit?: boolean;
	onRemove: (account: AccountResponse) => void;
	onRename: (account: AccountResponse) => void;
}

export function AccountListItem({
	account,
	isActive = false,
	onPauseToggle,
	onResetRateLimit,
	isResettingRateLimit = false,
	onRemove,
	onRename,
}: AccountListItemProps) {
	const presenter = new AccountPresenter(account);

	return (
		<div
			className={`p-4 border rounded-lg transition-colors space-y-4 ${
				isActive
					? "border-primary bg-primary/5 shadow-sm"
					: "border-border hover:border-muted-foreground/50"
			}`}
		>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<div>
						<div className="flex items-center gap-2">
							<p className="font-medium">{account.name}</p>
							{isActive && (
								<span className="px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
									Active
								</span>
							)}
						</div>
						<div className="mt-1 flex flex-wrap items-center gap-2">
							<ProviderBadge provider={account.provider} />
							<Badge
								variant={
									account.auth_method === "oauth" ? "secondary" : "outline"
								}
							>
								{getAuthMethodLabel(account.auth_method)}
							</Badge>
							<span className="text-sm text-muted-foreground">
								{presenter.weightDisplay}
							</span>
						</div>
					</div>
					<div className="flex items-center gap-2">
						{presenter.isRateLimited ? (
							<AlertCircle className="h-4 w-4 text-warning" />
						) : (
							<CheckCircle className="h-4 w-4 text-success" />
						)}
						<span className="text-sm">{presenter.requestCount} requests</span>
						{presenter.isPaused && (
							<span className="text-sm text-muted-foreground">Paused</span>
						)}
						{!presenter.isPaused && presenter.rateLimitStatus !== "OK" && (
							<span className="text-sm text-destructive">
								{presenter.rateLimitStatus}
							</span>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onRename(account)}
						title="Rename account"
					>
						<Edit2 className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onPauseToggle(account)}
						title={account.paused ? "Resume account" : "Pause account"}
					>
						{account.paused ? (
							<Play className="h-4 w-4" />
						) : (
							<Pause className="h-4 w-4" />
						)}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onRemove(account)}
						title="Delete account"
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			</div>
			{account.rateLimitReset && (
				<RateLimitProgress resetIso={account.rateLimitReset} />
			)}
			{account.quota && <QuotaSnapshot snapshot={account.quota} />}
			{account.rateLimitStatus.isLimited && (
				<div className="flex justify-end">
					<Button
						variant="outline"
						size="sm"
						onClick={() => onResetRateLimit(account.id)}
						disabled={isResettingRateLimit}
					>
						<RotateCcw className={isResettingRateLimit ? "animate-spin" : ""} />
						{isResettingRateLimit ? "Resetting..." : "Reset local rate limit"}
					</Button>
				</div>
			)}
		</div>
	);
}
