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
import type {
	Account,
	AccountCredentialManager,
	AccountProvider,
} from "@ccflare/types";
import type { AccountModelsResponse } from "../types";
import { credentialRefreshHttpError } from "./credential-errors";

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
	getProvider: (provider: AccountProvider) => Provider | undefined,
	credentialManager: AccountCredentialManager,
) {
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
			const beforeValidation = account;
			account = await credentialManager.getValidAccount(account);
			if (account.access_token !== beforeValidation.access_token) {
				refreshed = true;
			}

			let report = await provider.fetchModels(account);
			if (
				!refreshed &&
				report.state === "failed" &&
				hasUnauthorizedVersion(report)
			) {
				account = await credentialManager.refreshAfterUnauthorized(
					account,
					account.access_token ?? "",
				);
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
			const credentialError = credentialRefreshHttpError(error, account);
			if (credentialError) return errorResponse(credentialError);
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
