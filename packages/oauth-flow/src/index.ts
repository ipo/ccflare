import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import {
	generatePKCE,
	getOAuthProvider as getRegisteredOAuthProvider,
	type OAuthProvider,
	type OAuthProviderConfig,
	type OAuthTokens,
	type PKCEChallenge,
} from "@ccflare/providers";
import {
	isOAuthProvider,
	isRecord,
	type OAuthProvider as OAuthFlowProvider,
} from "@ccflare/types";

export {
	isOAuthProvider as isOAuthFlowProvider,
	type OAuthProvider as OAuthFlowProvider,
} from "@ccflare/types";

/**
 * Resolves the OAuthProvider implementation via the provider registry
 * rather than hardcoding class constructors. The registry is populated
 * at import time by @ccflare/providers.
 */
function getOAuthProviderForFlow(provider: OAuthFlowProvider): OAuthProvider {
	const oauthProvider = getRegisteredOAuthProvider(provider);
	if (!oauthProvider) {
		throw new Error(
			`No OAuth provider registered for '${provider}'. Ensure @ccflare/providers is imported.`,
		);
	}
	return oauthProvider;
}

async function discoverOAuthConfigForFlow(
	provider: OAuthFlowProvider,
	config: Config,
	oauthProvider: OAuthProvider,
): Promise<OAuthProviderConfig> {
	const discovered = oauthProvider.discoverConfig
		? await oauthProvider.discoverConfig()
		: oauthProvider.getOAuthConfig();
	if (provider === "claude-code")
		discovered.clientId = config.getRuntime().clientId;
	return discovered;
}

export interface BeginOptions {
	name: string;
	provider: OAuthFlowProvider;
}

export interface BeginResult {
	sessionId: string;
	authUrl: string;
	pkce: PKCEChallenge;
	oauthConfig: OAuthProviderConfig;
	/**
	 * Device-grant providers only: the short code the user confirms in the
	 * browser. Present so UIs can display it alongside the verification URL.
	 */
	userCode?: string;
	/** Resolves when a loopback callback has automatically completed the account. */
	completion?: Promise<AccountCreated>;
}

export interface CompleteOptions {
	sessionId: string;
	/**
	 * Authorization code. Empty for device-grant providers, which poll the
	 * token endpoint with the stored device code instead.
	 */
	code: string;
	name?: string;
}

export interface AccountCreated {
	id: string;
	name: string;
	provider: OAuthFlowProvider;
	authType: "oauth";
}

interface SessionState {
	verifier: string;
	state: string;
	status: "pending" | "completed";
	nonce?: string;
}

const loopbackServers = new Map<number, ReturnType<typeof Bun.serve>>();
const loopbackTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
const loopbackControllers = new Map<
	string,
	{ stop(): void; settle(account: AccountCreated): void }
>();

export function stopAllOAuthLoopbackServers(): void {
	for (const controller of [...loopbackControllers.values()]) controller.stop();
	for (const timeout of loopbackTimeouts.values()) clearTimeout(timeout);
	for (const server of loopbackServers.values()) server.stop(true);
	loopbackControllers.clear();
	loopbackTimeouts.clear();
	loopbackServers.clear();
}

function finishLoopbackSession(
	sessionId: string,
	account: AccountCreated,
): void {
	const controller = loopbackControllers.get(sessionId);
	if (!controller) return;
	controller.settle(account);
	controller.stop();
}

function browserPage(ok: boolean, detail: string): Response {
	return new Response(
		`<!doctype html><html><body><h1>${ok ? "Account connected" : "Authorization failed"}</h1><p>${detail.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p></body></html>`,
		{
			status: ok ? 200 : 400,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		},
	);
}

/**
 * Handles OAuth flows for OAuth-only providers and persists transient auth
 * session state in the generic auth_sessions table.
 */
export class OAuthFlow {
	constructor(
		private dbOps: DatabaseOperations,
		private config: Config,
	) {}

	/**
	 * Starts an OAuth flow for an OAuth-only provider.
	 *
	 * @param opts - OAuth flow options
	 * @param opts.name - Unique account name
	 * @returns OAuth flow data including auth URL and session info
	 * @throws {Error} If account name already exists
	 */
	async begin(opts: BeginOptions): Promise<BeginResult> {
		const { name, provider } = opts;

		// Check if account already exists
		if (this.dbOps.getAccountByName(name)) {
			throw new Error(`Account with name '${name}' already exists`);
		}

		// Get OAuth provider
		const oauthProvider = getOAuthProviderForFlow(provider);

		// Get OAuth config with provider-specific client ID handling
		const oauthConfig = await discoverOAuthConfigForFlow(
			provider,
			this.config,
			oauthProvider,
		);

		// Device-grant providers (e.g. Kimi) have no redirect and no PKCE: the
		// device code takes the verifier slot and is polled in complete().
		if (oauthProvider.beginDeviceAuthorization) {
			const device = await oauthProvider.beginDeviceAuthorization(oauthConfig);
			const pkce: PKCEChallenge = {
				verifier: device.deviceCode,
				challenge: "",
			};
			const sessionState: SessionState = {
				verifier: device.deviceCode,
				// No redirect callback matches on state here, but the column is
				// required and must stay unique across sessions.
				state: crypto.randomUUID(),
				status: "pending",
			};

			const sessionId = this.dbOps.createAuthSession(
				provider,
				"oauth",
				name,
				JSON.stringify(sessionState),
				device.expiresAt,
			);

			return {
				sessionId,
				authUrl: device.verificationUriComplete,
				pkce,
				oauthConfig,
				userCode: device.userCode,
			};
		}

		// Generate PKCE challenge
		const pkce = await generatePKCE();
		// Grok's loopback callback uses state as a CSRF secret, so keep it
		// independent from the PKCE verifier that must remain private.
		pkce.state = provider === "grok" ? crypto.randomUUID() : pkce.verifier;
		pkce.nonce = crypto.randomUUID();

		// Generate auth URL
		const authUrl = oauthProvider.generateAuthUrl(oauthConfig, pkce);

		const sessionState: SessionState = {
			verifier: pkce.verifier,
			state: pkce.state,
			nonce: pkce.nonce,
			status: "pending",
		};

		const sessionId = this.dbOps.createAuthSession(
			provider,
			"oauth",
			name,
			JSON.stringify(sessionState),
			Date.now() + 10 * 60 * 1000,
		);

		const result: BeginResult = {
			sessionId,
			authUrl,
			pkce,
			oauthConfig,
		};
		try {
			result.completion = this.startLoopbackCompletion(result);
		} catch (error) {
			this.dbOps.deleteAuthSession(sessionId);
			throw error;
		}
		return result;
	}

	/**
	 * Completes the OAuth flow after user authorization.
	 *
	 * @param opts - Completion options
	 * @param opts.sessionId - Session ID from {@link begin}
	 * @param opts.code - Authorization code from OAuth callback
	 * @param opts.name - Account name (must match the one from begin)
	 * @returns Created account information
	 * @throws {Error} If OAuth provider not found or token exchange fails
	 */
	async complete(
		opts: CompleteOptions,
		flowData?: BeginResult,
	): Promise<AccountCreated> {
		return this.completeSession(opts, flowData, false);
	}

	private async completeSession(
		opts: CompleteOptions,
		flowData: BeginResult | undefined,
		deferLoopbackStop: boolean,
	): Promise<AccountCreated> {
		const { sessionId, code } = opts;
		const authSession = this.dbOps.getAuthSession(sessionId);
		if (!authSession) {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		if (
			!isOAuthProvider(authSession.provider) ||
			authSession.authMethod !== "oauth"
		) {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		const sessionState = this.parseSessionState(authSession.stateJson);
		const provider = authSession.provider;
		const name = opts.name ?? authSession.accountName;

		if (sessionState.status === "completed") {
			const existingAccount = this.dbOps.getAccountByName(name);

			if (
				existingAccount &&
				existingAccount.provider === provider &&
				existingAccount.auth_method === "oauth"
			) {
				const account = {
					id: existingAccount.id,
					name: existingAccount.name,
					provider,
					authType: "oauth" as const,
				};
				if (!deferLoopbackStop) finishLoopbackSession(sessionId, account);
				return account;
			}

			throw new Error("OAuth session has already been completed.");
		}

		const resolvedFlowData =
			flowData ??
			(await this.createFlowDataFromSession(sessionId, provider, sessionState));

		// Get OAuth provider
		const oauthProvider = getOAuthProviderForFlow(provider);

		// Exchange authorization code for tokens
		const tokens = await oauthProvider.exchangeCode(
			code,
			resolvedFlowData.pkce.verifier,
			resolvedFlowData.oauthConfig,
			{ state: sessionState.state, nonce: sessionState.nonce },
		);

		const account = this.createAccountWithOAuth(name, provider, tokens);
		this.dbOps.updateAuthSessionState(
			sessionId,
			JSON.stringify({
				...sessionState,
				status: "completed",
			} satisfies SessionState),
			Date.now() + 5 * 60 * 1000,
		);
		if (!deferLoopbackStop) finishLoopbackSession(sessionId, account);
		return account;
	}

	private async createFlowDataFromSession(
		sessionId: string,
		provider: OAuthFlowProvider,
		sessionState: SessionState,
	): Promise<BeginResult> {
		const oauthProvider = getOAuthProviderForFlow(provider);
		const oauthConfig = await discoverOAuthConfigForFlow(
			provider,
			this.config,
			oauthProvider,
		);

		return {
			sessionId,
			authUrl: "",
			pkce: {
				verifier: sessionState.verifier,
				challenge: "",
			},
			oauthConfig,
		};
	}

	private parseSessionState(stateJson: string): SessionState {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stateJson);
		} catch {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		if (!isRecord(parsed) || typeof parsed.verifier !== "string") {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		if (typeof parsed.state !== "string") {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		if (parsed.status !== "pending" && parsed.status !== "completed") {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		return {
			verifier: parsed.verifier,
			state: parsed.state,
			status: parsed.status,
			...(typeof parsed.nonce === "string" && { nonce: parsed.nonce }),
		};
	}

	private createAccountWithOAuth(
		name: string,
		provider: OAuthFlowProvider,
		tokens: OAuthTokens,
	): AccountCreated {
		const account = this.dbOps.createOAuthAccount({
			name,
			provider,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken ?? null,
			expiresAt: tokens.expiresAt,
			oauthSubject: tokens.oauthSubject ?? null,
		});

		return {
			id: account.id,
			name: account.name,
			provider,
			authType: "oauth",
		};
	}

	private startLoopbackCompletion(
		flow: BeginResult,
	): Promise<AccountCreated> | undefined {
		const redirect = new URL(flow.oauthConfig.redirectUri);
		if (
			(redirect.hostname !== "127.0.0.1" &&
				redirect.hostname !== "localhost") ||
			!redirect.port
		)
			return undefined;
		const port = Number(redirect.port);
		if (loopbackServers.has(port)) {
			throw new Error(
				`OAuth callback port ${port} is already handling another login`,
			);
		}
		let settle!: (value: AccountCreated) => void;
		let reject!: (error: Error) => void;
		let server: ReturnType<typeof Bun.serve> | undefined;
		let controller:
			| { stop(): void; settle(account: AccountCreated): void }
			| undefined;
		const completion = new Promise<AccountCreated>((resolve, rejectPromise) => {
			settle = resolve;
			reject = rejectPromise;
		});
		const stop = () => {
			clearTimeout(timeout);
			server?.stop(true);
			if (loopbackServers.get(port) === server) {
				loopbackServers.delete(port);
				loopbackTimeouts.delete(port);
			}
			if (loopbackControllers.get(flow.sessionId) === controller) {
				loopbackControllers.delete(flow.sessionId);
			}
		};
		const timeout = setTimeout(
			() => {
				stop();
				this.dbOps.deleteAuthSession(flow.sessionId);
				reject(new Error("OAuth loopback callback timed out"));
			},
			10 * 60 * 1000,
		);
		timeout.unref?.();
		loopbackTimeouts.set(port, timeout);
		try {
			server = Bun.serve({
				hostname: redirect.hostname,
				port,
				fetch: async (request) => {
					const url = new URL(request.url);
					if (request.method !== "GET" || url.pathname !== redirect.pathname)
						return new Response("Not Found", { status: 404 });
					const code = url.searchParams.get("code");
					const state = url.searchParams.get("state");
					const providerError =
						url.searchParams.get("error_description") ??
						url.searchParams.get("error");
					if (providerError || !code || state !== flow.pkce.state) {
						const error = new Error(
							providerError ?? "OAuth callback state mismatch",
						);
						this.dbOps.deleteAuthSession(flow.sessionId);
						clearTimeout(timeout);
						setTimeout(stop, 250);
						reject(error);
						return browserPage(false, error.message);
					}
					try {
						const account = await this.completeSession(
							{ sessionId: flow.sessionId, code },
							flow,
							true,
						);
						clearTimeout(timeout);
						setTimeout(stop, 250);
						settle(account);
						return browserPage(
							true,
							"You can close this window and return to ccflare.",
						);
					} catch (cause) {
						const error =
							cause instanceof Error
								? cause
								: new Error("Failed to complete OAuth flow");
						this.dbOps.deleteAuthSession(flow.sessionId);
						clearTimeout(timeout);
						setTimeout(stop, 250);
						reject(error);
						return browserPage(false, error.message);
					}
				},
			});
			loopbackServers.set(port, server);
			controller = { stop, settle };
			loopbackControllers.set(flow.sessionId, controller);
		} catch (cause) {
			clearTimeout(timeout);
			loopbackTimeouts.delete(port);
			throw cause;
		}
		void completion.catch(() => {});
		return completion;
	}
}

// Helper function for simpler usage
export async function createOAuthFlow(
	dbOps: DatabaseOperations,
	config: Config,
): Promise<OAuthFlow> {
	return new OAuthFlow(dbOps, config);
}
