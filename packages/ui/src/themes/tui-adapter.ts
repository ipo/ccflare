import type { ThemePalette } from "./types";

export interface TuiColorMap {
	bg: string;
	surface: string;
	surfaceHover: string;
	border: string;
	borderActive: string;
	text: string;
	dim: string;
	muted: string;
	accent: string;
	accentDim: string;
	success: string;
	warning: string;
	error: string;
	info: string;
	chart1: string;
	chart2: string;
	chart3: string;
	chart4: string;
	chart5: string;
	anthropic: string;
	openai: string;
	claudeCode: string;
	codex: string;
	grok: string;
}

export function themeToTuiColors(theme: ThemePalette): TuiColorMap {
	return {
		bg: theme.background,
		surface: theme.card,
		surfaceHover: theme.secondary,
		border: theme.border,
		borderActive: theme.primary,
		text: theme.foreground,
		dim: theme.mutedForeground,
		muted: theme.border,
		accent: theme.primary,
		accentDim: theme.ring,
		success: theme.success,
		warning: theme.warning,
		error: theme.error,
		info: theme.info,
		chart1: theme.chart1,
		chart2: theme.chart2,
		chart3: theme.chart3,
		chart4: theme.chart4,
		chart5: theme.chart5,
		// Provider colors are brand identities — kept static
		anthropic: "#d4a064",
		openai: "#74aa9c",
		claudeCode: theme.primary,
		codex: theme.info,
		grok: theme.warning,
	};
}
