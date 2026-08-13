import { describe, expect, it } from "bun:test";
import { configureSourceUsageWorkerSidecar } from "./usage-worker-sidecar";

describe("TUI source usage worker sidecar", () => {
	it("selects the app JavaScript sidecar when present", () => {
		const environment: NodeJS.ProcessEnv = {};
		const checkedPaths: string[] = [];
		configureSourceUsageWorkerSidecar(environment, (path) => {
			checkedPaths.push(path);
			return true;
		});
		expect(environment.CF_USAGE_WORKER_PATH).toEndWith(
			"/apps/tui/dist/post-processor.worker.js",
		);
		expect(environment.CF_RETENTION_WORKER_PATH).toEndWith(
			"/apps/tui/dist/retention-cleanup.worker.js",
		);
		expect(checkedPaths).toHaveLength(2);
	});

	it("preserves an explicit override and no-sidecar fallback", () => {
		const explicit: NodeJS.ProcessEnv = {
			CF_USAGE_WORKER_PATH: "/custom/worker.js",
		};
		configureSourceUsageWorkerSidecar(explicit, () => true);
		expect(explicit.CF_USAGE_WORKER_PATH).toBe("/custom/worker.js");

		const fallback: NodeJS.ProcessEnv = {};
		configureSourceUsageWorkerSidecar(fallback, () => false);
		expect(fallback.CF_USAGE_WORKER_PATH).toBeUndefined();
	});
});
