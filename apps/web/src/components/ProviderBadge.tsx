import { getProviderDisplayLabel, isAccountProvider } from "@ccflare/types";
import { Badge } from "./ui/badge";

function getProviderLabel(provider: string): string {
	if (!provider) {
		return "Unknown";
	}

	if (isAccountProvider(provider)) {
		return getProviderDisplayLabel(provider);
	}

	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function getProviderVariant(
	provider: string,
): "secondary" | "success" | "outline" {
	switch (provider) {
		case "anthropic":
			return "secondary";
		case "openai":
			return "success";
		case "claude-code":
		case "codex":
		case "grok":
			return "outline";
		default:
			return "outline";
	}
}

interface ProviderBadgeProps {
	provider: string;
	className?: string;
}

export function ProviderBadge({ provider, className }: ProviderBadgeProps) {
	return (
		<Badge variant={getProviderVariant(provider)} className={className}>
			{getProviderLabel(provider)}
		</Badge>
	);
}
