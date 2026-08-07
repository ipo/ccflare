import { describe, expect, it } from "bun:test";
import { configureSourceUsageWorkerSidecar } from "./usage-worker-sidecar";

describe("server source usage worker sidecar", () => {
	it("selects the app JavaScript sidecar when present", () => {
		const environment: NodeJS.ProcessEnv = {};
		let checkedPath = "";
		configureSourceUsageWorkerSidecar(environment, (path) => {
			checkedPath = path;
			return true;
		});
		expect(checkedPath).toEndWith("/apps/server/dist/post-processor.worker.js");
		expect(environment.CF_USAGE_WORKER_PATH).toBe(checkedPath);
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
