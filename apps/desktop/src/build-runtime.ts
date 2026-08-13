import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "..");
const repoRoot = join(appRoot, "..", "..");
const runtimeDir = join(appRoot, ".desktop-runtime");
const dashboardPackageDir = join(repoRoot, "packages", "dashboard-web");
const dashboardDistDir = join(dashboardPackageDir, "dist");
const serverEntrypoint = join(appRoot, "src", "server", "index.ts");
const usageWorkerEntrypoint = join(
	repoRoot,
	"packages",
	"proxy",
	"src",
	"post-processor.worker.ts",
);
const retentionWorkerEntrypoint = join(
	repoRoot,
	"packages",
	"runtime-server",
	"src",
	"retention-cleanup.worker.ts",
);

function assertBuildSucceeded(
	result: Awaited<ReturnType<typeof Bun.build>>,
	label: string,
): void {
	if (result.success) {
		return;
	}

	console.error(`Failed to build ${label}`);
	for (const log of result.logs) {
		console.error(log);
	}
	throw new Error(`Desktop runtime build failed for ${label}`);
}

async function writeSingleBundle(
	entrypoint: string,
	outputPath: string,
	label: string,
): Promise<void> {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		target: "bun",
		format: "esm",
	});
	assertBuildSucceeded(result, label);

	const [output] = result.outputs;
	if (!output) {
		throw new Error(`Desktop runtime build produced no output for ${label}`);
	}

	await Bun.write(outputPath, output);
}

const dashboardBuild = Bun.spawnSync(
	[process.execPath, "run", "--cwd", dashboardPackageDir, "build"],
	{
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	},
);

if (dashboardBuild.exitCode !== 0) {
	throw new Error("Dashboard build failed");
}

if (!existsSync(dashboardDistDir)) {
	throw new Error(`Dashboard dist directory is missing at ${dashboardDistDir}`);
}

await rm(runtimeDir, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });

await writeSingleBundle(
	serverEntrypoint,
	join(runtimeDir, "server.js"),
	"desktop server bundle",
);

await writeSingleBundle(
	retentionWorkerEntrypoint,
	join(runtimeDir, "retention-cleanup.worker.js"),
	"desktop retention cleanup worker bundle",
);

await writeSingleBundle(
	usageWorkerEntrypoint,
	join(runtimeDir, "post-processor.worker.js"),
	"desktop usage worker bundle",
);

await cp(dashboardDistDir, join(runtimeDir, "dashboard"), { recursive: true });
