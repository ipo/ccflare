export {
	createServerFetchHandler,
	createStartupBanner,
	default,
	type ServerHandle,
	type StartServerOptions,
} from "@ccflare/runtime-server";

import startServer from "@ccflare/runtime-server";
import { configureSourceUsageWorkerSidecar } from "./usage-worker-sidecar";

configureSourceUsageWorkerSidecar();

if (import.meta.main) {
	startServer();
}
