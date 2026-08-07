import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const originalCleanupInterval = process.env.CLEANUP_INTERVAL_HOURS;
const tempDirs: string[] = [];

function configWith(data?: Record<string, unknown>): Config {
	const directory = mkdtempSync(join(tmpdir(), "ccflare-config-"));
	tempDirs.push(directory);
	const path = join(directory, "ccflare.json");
	if (data) writeFileSync(path, JSON.stringify(data));
	return new Config(path);
}

afterEach(() => {
	if (originalCleanupInterval === undefined) {
		delete process.env.CLEANUP_INTERVAL_HOURS;
	} else {
		process.env.CLEANUP_INTERVAL_HOURS = originalCleanupInterval;
	}
	for (const directory of tempDirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("cleanup interval configuration", () => {
	test("defaults to six hours", () => {
		delete process.env.CLEANUP_INTERVAL_HOURS;
		expect(configWith().getCleanupIntervalHours()).toBe(6);
	});

	test("reads cleanup_interval_hours from the config file", () => {
		delete process.env.CLEANUP_INTERVAL_HOURS;
		expect(
			configWith({ cleanup_interval_hours: 12 }).getCleanupIntervalHours(),
		).toBe(12);
	});

	test("prefers CLEANUP_INTERVAL_HOURS over the config file", () => {
		process.env.CLEANUP_INTERVAL_HOURS = "24";
		expect(
			configWith({ cleanup_interval_hours: 12 }).getCleanupIntervalHours(),
		).toBe(24);
	});

	test("clamps environment and file values to one through 168 hours", () => {
		process.env.CLEANUP_INTERVAL_HOURS = "0";
		expect(
			configWith({ cleanup_interval_hours: 200 }).getCleanupIntervalHours(),
		).toBe(1);
		delete process.env.CLEANUP_INTERVAL_HOURS;
		expect(
			configWith({ cleanup_interval_hours: 200 }).getCleanupIntervalHours(),
		).toBe(168);
	});
});
