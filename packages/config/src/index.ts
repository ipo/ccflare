import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	DEFAULT_STRATEGY,
	isValidStrategy,
	NETWORK,
	TIME_CONSTANTS,
} from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import {
	isFiniteNumber,
	isLbStrategy,
	isRecord,
	type StrategyName,
} from "@ccflare/types";
import { resolveConfigPath } from "./paths";

const log = new Logger("Config");

export interface RuntimeConfig {
	clientId: string;
	retry: { attempts: number; delayMs: number; backoff: number };
	sessionDurationMs: number;
	port: number;
}

export interface ConfigData {
	lb_strategy?: StrategyName;
	client_id?: string;
	retry_attempts?: number;
	retry_delay_ms?: number;
	retry_backoff?: number;
	session_duration_ms?: number;
	port?: number;
	data_retention_days?: number;
	request_retention_days?: number;
	cleanup_interval_hours?: number;
	[key: string]: string | number | boolean | undefined;
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeConfigData(value: unknown): ConfigData {
	if (!isRecord(value)) {
		return {};
	}

	const sanitized: ConfigData = {};

	for (const [key, entry] of Object.entries(value)) {
		if (
			typeof entry === "string" ||
			typeof entry === "boolean" ||
			isFiniteNumber(entry)
		) {
			sanitized[key] = entry;
		}
	}

	if (!isLbStrategy(String(sanitized.lb_strategy ?? ""))) {
		delete sanitized.lb_strategy;
	}

	const numericKeys = [
		"retry_attempts",
		"retry_delay_ms",
		"retry_backoff",
		"session_duration_ms",
		"port",
		"data_retention_days",
		"request_retention_days",
		"cleanup_interval_hours",
	] as const;

	for (const key of numericKeys) {
		const entry = sanitized[key];
		if (entry !== undefined && !isFiniteNumber(entry)) {
			delete sanitized[key];
		}
	}

	if (
		sanitized.client_id !== undefined &&
		typeof sanitized.client_id !== "string"
	) {
		delete sanitized.client_id;
	}

	return sanitized;
}

export class Config extends EventEmitter {
	private configPath: string;
	private data: ConfigData = {};

	constructor(configPath?: string) {
		super();
		this.configPath = configPath ?? resolveConfigPath();
		this.loadConfig();
	}

	private loadConfig(): void {
		if (existsSync(this.configPath)) {
			try {
				const content = readFileSync(this.configPath, "utf8");
				this.data = sanitizeConfigData(JSON.parse(content));
				if ("default_agent_model" in this.data) {
					delete this.data.default_agent_model;
					this.saveConfig();
				}
			} catch (error) {
				log.error(`Failed to parse config file: ${error}`);
				this.data = {};
			}
		} else {
			// Create config directory if it doesn't exist
			const dir = dirname(this.configPath);
			mkdirSync(dir, { recursive: true });

			// Initialize with default config
			this.data = {
				lb_strategy: DEFAULT_STRATEGY,
			};
			this.saveConfig();
		}
	}

	private saveConfig(): void {
		try {
			const content = JSON.stringify(this.data, null, 2);
			writeFileSync(this.configPath, content, "utf8");
		} catch (error) {
			log.error(`Failed to save config file: ${error}`);
		}
	}

	get(
		key: string,
		defaultValue?: string | number | boolean,
	): string | number | boolean | undefined {
		if (key in this.data) {
			return this.data[key];
		}

		if (defaultValue !== undefined) {
			this.set(key, defaultValue);
			return defaultValue;
		}

		return undefined;
	}

	set(key: string, value: string | number | boolean): void {
		const oldValue = this.data[key];
		this.data[key] = value;
		this.saveConfig();

		// Emit change event
		this.emit("change", { key, oldValue, newValue: value });
	}

	getStrategy(): StrategyName {
		// First check environment variable
		const envStrategy = process.env.LB_STRATEGY;
		if (envStrategy && isValidStrategy(envStrategy)) {
			return envStrategy;
		}

		// Then check config file
		const configStrategy = this.data.lb_strategy;
		if (configStrategy && isValidStrategy(configStrategy)) {
			return configStrategy;
		}

		return DEFAULT_STRATEGY;
	}

	setStrategy(strategy: StrategyName): void {
		if (!isValidStrategy(strategy)) {
			throw new Error(`Invalid strategy: ${strategy}`);
		}
		this.set("lb_strategy", strategy);
	}

	private clamp(n: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, n));
	}

	getDataRetentionDays(): number {
		const fromEnv = process.env.DATA_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 365);
		}
		const fromFile = this.data.data_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 365);
		return 7;
	}

	setDataRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 365);
		this.set("data_retention_days", clamped);
	}

	getRequestRetentionDays(): number {
		const fromEnv = process.env.REQUEST_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.request_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 365; // default metadata retention
	}

	setRequestRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("request_retention_days", clamped);
	}

	getCleanupIntervalHours(): number {
		const fromEnv = process.env.CLEANUP_INTERVAL_HOURS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 168);
		}
		const fromFile = this.data.cleanup_interval_hours;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 168);
		return 6;
	}

	getAllSettings(): Record<string, string | number | boolean | undefined> {
		// Include current strategy (which might come from env)
		return {
			...this.data,
			lb_strategy: this.getStrategy(),
			data_retention_days: this.getDataRetentionDays(),
			request_retention_days: this.getRequestRetentionDays(),
			cleanup_interval_hours: this.getCleanupIntervalHours(),
		};
	}

	getRuntime(): RuntimeConfig {
		// Default values
		const defaults: RuntimeConfig = {
			clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			retry: {
				attempts: 3,
				delayMs: TIME_CONSTANTS.RETRY_DELAY_DEFAULT,
				backoff: 2,
			},
			sessionDurationMs: TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
			port: NETWORK.DEFAULT_PORT,
		};

		// Override with environment variables if present
		if (process.env.CLIENT_ID) {
			defaults.clientId = process.env.CLIENT_ID;
		}
		const retryAttempts = parseNumber(process.env.RETRY_ATTEMPTS);
		if (retryAttempts !== undefined) {
			defaults.retry.attempts = retryAttempts;
		}
		const retryDelayMs = parseNumber(process.env.RETRY_DELAY_MS);
		if (retryDelayMs !== undefined) {
			defaults.retry.delayMs = retryDelayMs;
		}
		const retryBackoff = parseNumber(process.env.RETRY_BACKOFF);
		if (retryBackoff !== undefined) {
			defaults.retry.backoff = retryBackoff;
		}
		const sessionDurationMs = parseNumber(process.env.SESSION_DURATION_MS);
		if (sessionDurationMs !== undefined) {
			defaults.sessionDurationMs = sessionDurationMs;
		}
		const port = parseNumber(process.env.PORT);
		if (port !== undefined) {
			defaults.port = port;
		}

		// Override with config file settings if present
		if (this.data.client_id) {
			defaults.clientId = this.data.client_id;
		}
		if (typeof this.data.retry_attempts === "number") {
			defaults.retry.attempts = this.data.retry_attempts;
		}
		if (typeof this.data.retry_delay_ms === "number") {
			defaults.retry.delayMs = this.data.retry_delay_ms;
		}
		if (typeof this.data.retry_backoff === "number") {
			defaults.retry.backoff = this.data.retry_backoff;
		}
		if (typeof this.data.session_duration_ms === "number") {
			defaults.sessionDurationMs = this.data.session_duration_ms;
		}
		if (typeof this.data.port === "number") {
			defaults.port = this.data.port;
		}

		return defaults;
	}
}

export { resolveConfigPath } from "./paths";
export { getPlatformConfigDir } from "./paths-common";
