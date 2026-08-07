import type { AccountProvider } from "./provider-metadata";
import type { StrategyName } from "./strategy";

export const TIME_RANGES = Object.freeze([
	"1h",
	"6h",
	"24h",
	"7d",
	"30d",
]) as readonly ["1h", "6h", "24h", "7d", "30d"];

export type TimeRange = (typeof TIME_RANGES)[number];

export function isTimeRange(value: string): value is TimeRange {
	return TIME_RANGES.includes(value as TimeRange);
}

export const ANALYTICS_MODES = Object.freeze([
	"normal",
	"cumulative",
]) as readonly ["normal", "cumulative"];

export type AnalyticsMode = (typeof ANALYTICS_MODES)[number];

export function isAnalyticsMode(value: string): value is AnalyticsMode {
	return ANALYTICS_MODES.includes(value as AnalyticsMode);
}

export const ANALYTICS_STATUS_FILTERS = Object.freeze([
	"all",
	"success",
	"error",
]) as readonly ["all", "success", "error"];

export type AnalyticsStatusFilter = (typeof ANALYTICS_STATUS_FILTERS)[number];

export function isAnalyticsStatusFilter(
	value: string,
): value is AnalyticsStatusFilter {
	return ANALYTICS_STATUS_FILTERS.includes(value as AnalyticsStatusFilter);
}

export interface Stats {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	topModels: Array<{ model: string; count: number }>;
	avgTokensPerSecond: number | null;
}

export interface StatsWithAccounts extends Stats {
	accounts: Array<{
		name: string;
		requestCount: number;
		successRate: number;
	}>;
	recentErrors: string[];
}

// Analytics types
export interface TimePoint {
	ts: number; // period start (ms)
	model?: string; // Optional model name for per-model time series
	requests: number;
	tokens: number;
	costUsd: number;
	successRate: number; // 0-100
	errorRate: number; // 0-100
	cacheHitRate: number; // 0-100
	avgResponseTime: number; // ms
	avgTokensPerSecond: number | null;
}

export interface TokenBreakdown {
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
}

export interface ModelPerformance {
	model: string;
	avgResponseTime: number;
	p95ResponseTime: number;
	errorRate: number;
	avgTokensPerSecond: number | null;
	minTokensPerSecond: number | null;
	maxTokensPerSecond: number | null;
}

export interface AsyncWriterHealth {
	healthy: boolean;
	failureCount: number;
	queuedJobs: number;
}

export interface UsageWorkerHealth {
	state: "starting" | "ready" | "degraded" | "shutting_down" | "stopped";
	queuedMessages: number;
	pendingAcks: number;
	lastError: string | null;
}

export interface WebSocketRecorderHealth {
	healthy: boolean;
	failureCount: number;
	activeSessions: number;
	bufferedEntries: number;
	lastError: string | null;
}

export interface RuntimeHealth {
	asyncWriter: AsyncWriterHealth;
	usageWorker: UsageWorkerHealth;
	websocketRecorder?: WebSocketRecorderHealth;
}

export interface AnalyticsResponse {
	meta?: {
		range: TimeRange;
		bucket: string;
		cumulative?: boolean;
	};
	totals: {
		requests: number;
		successRate: number;
		activeAccounts: number;
		avgResponseTime: number;
		totalTokens: number;
		totalCostUsd: number;
		avgTokensPerSecond: number | null;
	};
	timeSeries: TimePoint[];
	tokenBreakdown: TokenBreakdown;
	modelDistribution: Array<{ model: string; count: number }>;
	accountPerformance: Array<{
		name: string;
		requests: number;
		successRate: number;
	}>;
	providerBreakdown: Array<{
		provider: AccountProvider;
		requests: number;
		successRate: number;
		totalTokens: number;
		totalCostUsd: number;
	}>;
	costByModel: Array<{
		model: string;
		costUsd: number;
		requests: number;
		totalTokens?: number;
	}>;
	modelPerformance: ModelPerformance[];
}

// Health check response
export interface HealthResponse {
	status: string;
	accounts: number;
	timestamp: string;
	strategy: StrategyName;
	providers: AccountProvider[];
	runtime?: RuntimeHealth;
}

// Config types
export interface ConfigResponse {
	lbStrategy: StrategyName;
	port: number;
	sessionDurationMs: number;
}

export interface StrategyUpdateRequest {
	strategy: StrategyName;
}
