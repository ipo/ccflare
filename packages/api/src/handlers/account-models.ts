import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import {
	BadGateway,
	errorResponse,
	jsonResponse,
	NotFound,
	NotImplemented,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import type { Provider, ProviderModelsReport } from "@ccflare/providers";
import { sanitizeQuotaData } from "@ccflare/providers";
import type { Account, AccountProvider } from "@ccflare/types";
import type { AccountModelsResponse } from "../types";
import {
	createAccountCredentialRefresher,
	needsTokenRefresh,
} from "./account-credentials";

const log = new Logger("AccountModelsHandler");
const MODELS_PROVIDERS = new Set<AccountProvider>(["codex"]);

function hasUnauthorizedVersion(report: ProviderModelsReport): boolean {
	return report.versions.some((version) => version.status === 401);
}

function toModelsResponse(
	account: Account,
	report: ProviderModelsReport,
): AccountModelsResponse {
	return {
		account: {
			id: account.id,
			name: account.name,
			provider: account.provider,
		},
		state: report.state,
		collectedAt: report.collectedAt,
		versions: sanitizeQuotaData(report.versions, [
			account.access_token ?? "",
			account.refresh_token ?? "",
		]) as AccountModelsResponse["versions"],
	};
}

/**
 * Fetch the provider-native model catalog for one selected account without
 * involving load balancing. Only Codex accounts are supported; every other
 * provider returns 501 for now.
 */
export function createAccountModelsHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getProvider: (provider: AccountProvider) => Provider | undefined,
) {
	const refreshAccount = createAccountCredentialRefresher(dbOps, config);

	return async (_req: Request, accountId: string): Promise<Response> => {
		let account = dbOps.getAccount(accountId);
		if (!account) {
			return errorResponse(NotFound("Account not found"));
		}

		if (!MODELS_PROVIDERS.has(account.provider)) {
			return errorResponse(
				NotImplemented(
					`Model listing is not implemented for provider '${account.provider}'`,
					{ provider: account.provider },
				),
			);
		}

		const provider = getProvider(account.provider);
		if (!provider?.fetchModels) {
			return errorResponse(
				NotImplemented(
					`Model listing is not implemented for provider '${account.provider}'`,
					{ provider: account.provider },
				),
			);
		}

		let refreshed = false;
		try {
			if (needsTokenRefresh(account)) {
				account = await refreshAccount(account, provider);
				refreshed = true;
			}

			let report = await provider.fetchModels(account);
			if (
				!refreshed &&
				report.state === "failed" &&
				hasUnauthorizedVersion(report)
			) {
				account = await refreshAccount(account, provider);
				report = await provider.fetchModels(account);
			}

			const response = toModelsResponse(account, report);
			if (report.state === "failed") {
				return errorResponse(
					BadGateway("All provider model catalog requests failed", response),
				);
			}

			return jsonResponse(response);
		} catch (error) {
			log.error(
				`Model listing failed for account ${account.id} (${account.provider})`,
				error instanceof Error ? error.name : "Unknown failure",
			);
			return errorResponse(
				BadGateway("Failed to fetch account models", {
					account: {
						id: account.id,
						name: account.name,
						provider: account.provider,
					},
				}),
			);
		}
	};
}
