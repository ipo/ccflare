import type { Config } from "@ccflare/config";
import {
	patterns,
	sanitizers,
	ValidationError,
	validateString,
} from "@ccflare/core";
import type { DatabaseOperations } from "@ccflare/database";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import {
	ACCOUNT_PROVIDERS,
	type AccountCreateData,
	type AccountDeleteData,
	type AccountPauseData,
	type AccountRenameData,
	type AccountUpdateData,
	AUTH_METHODS,
	getProviderAuthMethod,
	isAccountProvider,
	isAuthMethod,
	type MutationResult,
} from "@ccflare/types";
import { serializeAccountQuotaSnapshot } from "../account-quota-service";
import { serializeAccount } from "../serializers/account";
import type { AccountResponse } from "../types";
import { parseJsonObject } from "../utils/json";

const log = new Logger("AccountsHandler");
const supportedProviders = ACCOUNT_PROVIDERS;
const supportedAuthMethods = AUTH_METHODS;
const DEFAULT_ACCOUNT_WEIGHT = 1;
const createAccountFields = new Set([
	"name",
	"provider",
	"auth_method",
	"api_key",
	"apiKey",
	"access_token",
	"accessToken",
	"refresh_token",
	"refreshToken",
	"base_url",
	"baseUrl",
]);
const updateAccountFields = new Set(["name", "base_url", "baseUrl"]);
function hasOwnField(body: Record<string, unknown>, field: string): boolean {
	return Object.hasOwn(body, field);
}

function normalizeBaseUrl(value: unknown): string | null {
	if (value === undefined) {
		return null;
	}

	if (value === null || value === "") {
		return null;
	}

	return (
		validateString(value, "base_url", {
			minLength: 1,
			transform: sanitizers.trim,
		}) || null
	);
}

function findUnexpectedField(
	body: Record<string, unknown>,
	allowedFields: ReadonlySet<string>,
): string | null {
	for (const key of Object.keys(body)) {
		if (!allowedFields.has(key)) {
			return key;
		}
	}

	return null;
}

function isDuplicateAccountNameError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("UNIQUE constraint failed: accounts.name") ||
			error.message.includes("already exists"))
	);
}

/**
 * Create an accounts list handler
 */
export function createAccountsListHandler(dbOps: DatabaseOperations) {
	return (): Response => {
		const now = Date.now();
		const quotaByAccount = new Map(
			dbOps
				.getAllAccountQuotaSnapshots()
				.map((snapshot) => [snapshot.accountId, snapshot]),
		);
		const response: AccountResponse[] = dbOps
			.getAllAccounts()
			.sort((left, right) => right.request_count - left.request_count)
			.map((account) =>
				serializeAccount(
					account,
					now,
					serializeAccountQuotaSnapshot(quotaByAccount.get(account.id) ?? null),
				),
			);

		return jsonResponse(response);
	};
}

/** Clear local rate-limit gating so an account can be attempted immediately. */
export function createAccountRateLimitResetHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = dbOps.getAccount(accountId);
			if (!account) return errorResponse(NotFound("Account not found"));

			dbOps.clearAccountRateLimit(account.id);
			const result: MutationResult<{ accountId: string }> = {
				success: true,
				message: `Local rate-limit state reset for account '${account.name}'`,
				data: { accountId: account.id },
			};
			return jsonResponse(result);
		} catch (error) {
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to reset account rate-limit state"),
			);
		}
	};
}

/**
 * Create an account add handler (manual token addition)
 * This is primarily used for adding accounts with existing tokens
 * For OAuth flow, use the OAuth handlers
 */
export function createAccountAddHandler(
	dbOps: DatabaseOperations,
	_config: Config,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await parseJsonObject(req);

			const unexpectedField = findUnexpectedField(body, createAccountFields);
			if (unexpectedField) {
				return errorResponse(
					BadRequest(`Unknown field '${unexpectedField}' in account payload`),
				);
			}

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				transform: sanitizers.trim,
			});
			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate provider
			const provider = validateString(body.provider, "provider", {
				required: true,
				allowedValues: supportedProviders,
				transform: sanitizers.trim,
			});
			if (!provider || !isAccountProvider(provider)) {
				return errorResponse(BadRequest("Provider is required"));
			}

			const authMethod = validateString(
				body.auth_method ??
					(body.api_key || body.apiKey
						? "api_key"
						: body.accessToken || body.access_token
							? "oauth"
							: undefined),
				"auth_method",
				{
					required: true,
					allowedValues: supportedAuthMethods,
					transform: sanitizers.trim,
				},
			);
			if (!authMethod || !isAuthMethod(authMethod)) {
				return errorResponse(BadRequest("auth_method is required"));
			}

			const allowedAuthMethod = getProviderAuthMethod(provider);
			if (authMethod !== allowedAuthMethod) {
				return errorResponse(
					BadRequest(
						`Provider '${provider}' only supports auth_method '${allowedAuthMethod}'`,
					),
				);
			}

			const baseUrl = normalizeBaseUrl(body.base_url ?? body.baseUrl);

			try {
				let createdAccount: ReturnType<DatabaseOperations["createAccount"]>;
				if (authMethod === "api_key") {
					const apiKey =
						validateString(body.api_key ?? body.apiKey, "api_key", {
							minLength: 1,
						}) || null;

					if (!apiKey) {
						return errorResponse(
							BadRequest("API key is required for api_key accounts"),
						);
					}

					createdAccount = dbOps.createApiKeyAccount({
						name,
						provider,
						apiKey,
						baseUrl,
						weight: DEFAULT_ACCOUNT_WEIGHT,
					});
				} else {
					const accessToken =
						validateString(
							body.accessToken ?? body.access_token,
							"accessToken",
							{
								minLength: 1,
							},
						) || null;

					const refreshToken =
						validateString(
							body.refreshToken ?? body.refresh_token,
							"refreshToken",
							{
								minLength: 1,
							},
						) || null;

					if (!accessToken) {
						return errorResponse(
							BadRequest("Access token is required for oauth accounts"),
						);
					}

					createdAccount = dbOps.createOAuthAccount({
						name,
						provider,
						accessToken,
						refreshToken,
						baseUrl,
						weight: DEFAULT_ACCOUNT_WEIGHT,
					});
				}

				const result: MutationResult<AccountCreateData> = {
					success: true,
					message: `Account '${name}' added successfully`,
					data: {
						accountId: createdAccount.id,
						weight: DEFAULT_ACCOUNT_WEIGHT,
						authMethod,
					},
				};
				return jsonResponse(result);
			} catch (error) {
				if (isDuplicateAccountNameError(error)) {
					return errorResponse(BadRequest(`Account '${name}' already exists`));
				}
				return errorResponse(InternalServerError((error as Error).message));
			}
		} catch (error) {
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			log.error("Account add error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to add account"),
			);
		}
	};
}

/**
 * Create an account update handler
 */
export function createAccountUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await parseJsonObject(req);
			const account = dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const unexpectedField = findUnexpectedField(body, updateAccountFields);
			if (unexpectedField) {
				return errorResponse(
					BadRequest(`Unknown field '${unexpectedField}' in account payload`),
				);
			}

			const hasName = hasOwnField(body, "name");
			const hasBaseUrl =
				hasOwnField(body, "base_url") || hasOwnField(body, "baseUrl");

			if (!hasName && !hasBaseUrl) {
				return errorResponse(
					BadRequest("At least one of 'name' or 'base_url' is required"),
				);
			}

			let nextName = account.name;
			if (hasName) {
				const validatedName = validateString(body.name, "name", {
					required: true,
					minLength: 1,
					maxLength: 100,
					pattern: patterns.accountName,
					transform: sanitizers.trim,
				});
				if (!validatedName) {
					return errorResponse(BadRequest("Account name is required"));
				}
				nextName = validatedName;
			}
			const nextBaseUrl = hasBaseUrl
				? normalizeBaseUrl(body.base_url ?? body.baseUrl)
				: account.base_url;

			if (nextName !== account.name) {
				const existingAccount = dbOps.getAccountByName(nextName);

				if (existingAccount && existingAccount.id !== accountId) {
					return errorResponse(
						BadRequest(`Account name '${nextName}' is already taken`),
					);
				}
			}

			const updatedAccount = dbOps.updateAccount(accountId, {
				name: nextName,
				base_url: nextBaseUrl,
			});

			if (!updatedAccount) {
				return errorResponse(NotFound("Account not found"));
			}

			const result: MutationResult<AccountUpdateData> = {
				success: true,
				message: `Account '${updatedAccount.name}' updated successfully`,
				data: {
					accountId,
					name: updatedAccount.name,
					baseUrl: updatedAccount.base_url,
				},
			};
			return jsonResponse(result);
		} catch (error) {
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			if (isDuplicateAccountNameError(error)) {
				return errorResponse(BadRequest("Account name is already taken"));
			}
			log.error("Account update error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to update account"),
			);
		}
	};
}

/**
 * Create an account remove handler
 */
export function createAccountRemoveHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (!dbOps.deleteAccount(account.id)) {
				return errorResponse(NotFound("Account not found"));
			}

			const result: MutationResult<AccountDeleteData> = {
				success: true,
				message: `Account '${account.name}' removed successfully`,
				data: { accountId: account.id },
			};
			return jsonResponse(result);
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to remove account"),
			);
		}
	};
}

function createAccountPauseStateHandler(
	dbOps: DatabaseOperations,
	shouldPause: boolean,
) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const isPaused = account.paused;
			if (shouldPause && !isPaused) {
				dbOps.pauseAccount(accountId);
			}

			if (!shouldPause && isPaused) {
				dbOps.resumeAccount(accountId);
			}

			const actionPast = shouldPause ? "paused" : "resumed";
			const alreadyMessage = shouldPause ? "already paused" : "already resumed";

			const result: MutationResult<AccountPauseData> = {
				success: true,
				message:
					isPaused === shouldPause
						? `Account '${account.name}' is ${alreadyMessage}`
						: `Account '${account.name}' ${actionPast} successfully`,
				data: { paused: shouldPause },
			};
			return jsonResponse(result);
		} catch (error) {
			return errorResponse(
				error instanceof Error
					? error
					: new Error(
							shouldPause
								? "Failed to pause account"
								: "Failed to resume account",
						),
			);
		}
	};
}

/**
 * Create an account pause handler
 */
export function createAccountPauseHandler(dbOps: DatabaseOperations) {
	return createAccountPauseStateHandler(dbOps, true);
}

/**
 * Create an account resume handler
 */
export function createAccountResumeHandler(dbOps: DatabaseOperations) {
	return createAccountPauseStateHandler(dbOps, false);
}

/**
 * Create an account rename handler
 */
export function createAccountRenameHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await parseJsonObject(req);

			// Validate new name
			const newName = validateString(body.name, "name", {
				required: true,
				transform: sanitizers.trim,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
			});
			if (!newName) {
				return errorResponse(BadRequest("New account name is required"));
			}

			const account = dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if new name is already taken
			const existingAccount = dbOps.getAccountByName(newName);

			if (existingAccount && existingAccount.id !== accountId) {
				return errorResponse(
					BadRequest(`Account name '${newName}' is already taken`),
				);
			}

			const renamedAccount = dbOps.updateAccount(accountId, { name: newName });

			if (!renamedAccount) {
				return errorResponse(NotFound("Account not found"));
			}

			const result: MutationResult<AccountRenameData> = {
				success: true,
				message: `Account renamed from '${account.name}' to '${renamedAccount.name}'`,
				data: { newName: renamedAccount.name },
			};
			return jsonResponse(result);
		} catch (error) {
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			if (isDuplicateAccountNameError(error)) {
				return errorResponse(BadRequest("Account name is already taken"));
			}
			log.error("Account rename error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to rename account"),
			);
		}
	};
}
