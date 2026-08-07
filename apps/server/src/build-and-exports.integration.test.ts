import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const PACKAGES_ROOT = join(REPO_ROOT, "packages");
const APPS_ROOT = join(REPO_ROOT, "apps");

type PackageManifest = {
	name: string;
	exports?: Record<string, string>;
	scripts?: Record<string, string>;
};

function readJsonFile<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function getPackageManifests(packagesRoot = PACKAGES_ROOT): PackageManifest[] {
	return readdirSync(packagesRoot, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(packagesRoot, entry.name, "package.json")),
		)
		.map((entry) =>
			readJsonFile<PackageManifest>(
				join(packagesRoot, entry.name, "package.json"),
			),
		);
}

describe("workspace build and export contracts", () => {
	it("declares an exports field for every package under packages/", () => {
		const missingExports = getPackageManifests()
			.filter((manifest) => !manifest.exports)
			.map((manifest) => manifest.name)
			.sort();

		expect(missingExports).toEqual([]);
	});

	it("ignores directories without a package manifest", () => {
		const packagesRoot = mkdtempSync(join(tmpdir(), "ccflare-packages-"));

		try {
			mkdirSync(join(packagesRoot, "workspace-package"));
			writeFileSync(
				join(packagesRoot, "workspace-package", "package.json"),
				JSON.stringify({ name: "workspace-package" }),
			);
			mkdirSync(join(packagesRoot, "stale-directory"));

			expect(getPackageManifests(packagesRoot)).toEqual([
				{ name: "workspace-package" },
			]);
		} finally {
			rmSync(packagesRoot, { force: true, recursive: true });
		}
	});

	it("exposes the dashboard manifest through a declared package export", () => {
		const manifest = readJsonFile<PackageManifest>(
			join(APPS_ROOT, "web", "package.json"),
		);

		expect(manifest.exports).toMatchObject({
			".": "./src/index.ts",
			"./manifest.json": "./dist/manifest.json",
		});
	});

	it("uses the dashboard HTML shell as the single dev entrypoint", () => {
		const rootManifest = readJsonFile<PackageManifest>(
			join(REPO_ROOT, "package.json"),
		);
		const dashboardManifest = readJsonFile<PackageManifest>(
			join(APPS_ROOT, "web", "package.json"),
		);

		expect(rootManifest.scripts?.["dev:dashboard"]).toBe(
			"bun run --cwd apps/web dev",
		);
		expect(dashboardManifest.scripts?.dev).toBe("bun --hot src/index.html");
	});

	it("keeps bun run build working while exposing a scoped build name", () => {
		const rootManifest = readJsonFile<PackageManifest>(
			join(REPO_ROOT, "package.json"),
		);

		expect(rootManifest.scripts?.["build:clients"]).toBe(
			"bun run build:dashboard && bun run build:tui",
		);
		expect(rootManifest.scripts?.build).toBe("bun run build:clients");
	});

	it("delegates source startup to app scripts that build the worker sidecar", () => {
		const rootManifest = readJsonFile<PackageManifest>(
			join(REPO_ROOT, "package.json"),
		);
		const serverManifest = readJsonFile<PackageManifest>(
			join(APPS_ROOT, "server", "package.json"),
		);
		const tuiManifest = readJsonFile<PackageManifest>(
			join(APPS_ROOT, "tui", "package.json"),
		);

		expect(rootManifest.scripts).toMatchObject({
			start: "bun run --cwd apps/server start",
			server: "bun run --cwd apps/server start",
			"dev:server": "bun run --cwd apps/server dev",
			tui: "bun run --cwd apps/tui dev",
		});
		expect(serverManifest.scripts?.start).toStartWith("bun run build:worker");
		expect(serverManifest.scripts?.dev).toStartWith("bun run build:worker");
		expect(serverManifest.scripts?.build).toStartWith("bun run build:worker");
		expect(tuiManifest.scripts?.dev).toStartWith("bun run build:worker");
		expect(tuiManifest.scripts?.build).toStartWith("bun run build:worker");
		expect(serverManifest.scripts?.["build:worker"]).toContain(
			"dist/post-processor.worker.js",
		);
		expect(tuiManifest.scripts?.["build:worker"]).toContain(
			"dist/post-processor.worker.js",
		);
	});

	it("imports dashboard assets through package exports instead of dist internals", () => {
		const runtimeServerSrc = join(PACKAGES_ROOT, "runtime-server", "src");
		const runtimeServerSource = readdirSync(runtimeServerSrc)
			.filter((file) => file.endsWith(".ts"))
			.map((file) => readFileSync(join(runtimeServerSrc, file), "utf8"))
			.join("\n");

		expect(runtimeServerSource).toContain("@ccflare/web/manifest.json");
		expect(runtimeServerSource).not.toContain(
			"@ccflare/web/dist/manifest.json",
		);
		expect(runtimeServerSource).not.toContain("@ccflare/web/dist");
		expect(runtimeServerSource).not.toContain("apps/web/dist");
	});
});
