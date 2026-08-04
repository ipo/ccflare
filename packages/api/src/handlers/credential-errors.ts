import { Unauthorized } from "@ccflare/http";
import { OAuthTokenRefreshError } from "@ccflare/providers";
import { type Account, getProviderDisplayLabel } from "@ccflare/types";

export function credentialRefreshHttpError(error: unknown, account: Account) {
	if (!(error instanceof OAuthTokenRefreshError) || !error.requiresSignIn) {
		return null;
	}
	const provider =
		account.provider === "kimi"
			? "Kimi"
			: getProviderDisplayLabel(account.provider);
	return Unauthorized(
		`${provider} account '${account.name}' must sign in again`,
	);
}
