import { existsSync } from "node:fs";
import { join } from "node:path";

const desktopRuntimeDir = import.meta.dir;
const usageWorkerPath = join(desktopRuntimeDir, "post-processor.worker.js");
const retentionWorkerPath = join(
	desktopRuntimeDir,
	"retention-cleanup.worker.js",
);
const dashboardDistDir = join(desktopRuntimeDir, "dashboard");

if (!existsSync(usageWorkerPath)) {
	throw new Error(
		`Desktop usage worker bundle is missing at ${usageWorkerPath}`,
	);
}

if (!existsSync(retentionWorkerPath)) {
	throw new Error(
		`Desktop retention worker bundle is missing at ${retentionWorkerPath}`,
	);
}

if (!existsSync(dashboardDistDir)) {
	throw new Error(`Desktop dashboard bundle is missing at ${dashboardDistDir}`);
}

process.env.CF_USAGE_WORKER_PATH ??= usageWorkerPath;
process.env.CF_RETENTION_WORKER_PATH ??= retentionWorkerPath;
process.env.CF_DASHBOARD_DIST_DIR ??= dashboardDistDir;

const requestedPort = Number(process.env.CCFLARE_DESKTOP_PORT || 0);
const port =
	Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0;

const { default: startServer } = await import("@ccflare/runtime-server");

const server = startServer({
	port,
	withDashboard: true,
});

console.log(`CCFLARE_DESKTOP_SERVER_READY ${server.port}`);
