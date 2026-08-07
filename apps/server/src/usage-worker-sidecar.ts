import { existsSync } from "node:fs";
import { join } from "node:path";

export function configureSourceUsageWorkerSidecar(
	environment: NodeJS.ProcessEnv = process.env,
	fileExists: (path: string) => boolean = existsSync,
): void {
	const sidecarPath = join(import.meta.dir, "../dist/post-processor.worker.js");
	if (
		environment.CF_USAGE_WORKER_PATH === undefined &&
		fileExists(sidecarPath)
	) {
		environment.CF_USAGE_WORKER_PATH = sidecarPath;
	}
}
