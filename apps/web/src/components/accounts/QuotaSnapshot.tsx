import type { AccountQuotaSnapshot, AccountQuotaWindow } from "@ccflare/api";
import { Badge } from "../ui/badge";
import { Progress } from "../ui/progress";

interface QuotaSnapshotProps {
	snapshot: AccountQuotaSnapshot;
}

function formatAmount(value: number): string {
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
		value,
	);
}

function formatReset(resetAt: string): string {
	const reset = new Date(resetAt);
	if (Number.isNaN(reset.getTime())) return resetAt;
	return reset.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function QuotaWindow({ window }: { window: AccountQuotaWindow }) {
	const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
	const hasAmounts = window.used !== undefined && window.limit !== undefined;
	const indicatorClassName =
		window.period === "5h"
			? "bg-chart-2"
			: window.period === "7d"
				? "bg-chart-3"
				: "bg-chart-1";

	return (
		<div className="space-y-2 rounded-md border border-border/70 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-medium">{window.label}</span>
					<Badge variant="outline">{window.period}</Badge>
					{window.scope === "model" && (
						<Badge variant="secondary">
							Model{window.model ? ` · ${window.model}` : ""}
						</Badge>
					)}
					{window.scope === "meter" && (
						<Badge variant="secondary">
							Meter{window.model ? ` · ${window.model}` : ""}
						</Badge>
					)}
				</div>
				<span className="text-sm font-medium">
					{usedPercent.toFixed(0)}% used
				</span>
			</div>
			<Progress
				value={usedPercent}
				className="h-2"
				indicatorClassName={indicatorClassName}
			/>
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>
					{hasAmounts
						? `${formatAmount(window.used as number)} of ${formatAmount(window.limit as number)} used`
						: `${Math.max(0, 100 - usedPercent).toFixed(0)}% remaining`}
				</span>
				{window.resetAt && <span>Resets {formatReset(window.resetAt)}</span>}
			</div>
		</div>
	);
}

export function QuotaSnapshot({ snapshot }: QuotaSnapshotProps) {
	if (snapshot.windows.length === 0 && snapshot.state === "fresh") return null;

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium text-muted-foreground">
					Provider quota
				</span>
				{snapshot.state !== "fresh" && (
					<Badge variant="outline">
						{snapshot.state === "error" ? "Unavailable" : "Stale"}
					</Badge>
				)}
			</div>
			{snapshot.windows.length > 0 ? (
				<div className="grid gap-2 md:grid-cols-2">
					{snapshot.windows.map((window) => (
						<QuotaWindow key={window.id} window={window} />
					))}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					{snapshot.error ?? "Quota data is currently unavailable."}
				</p>
			)}
		</div>
	);
}
