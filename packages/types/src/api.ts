import type { AuthMethod, OAuthProvider } from "./provider-metadata";
import type { HttpMethod } from "./request";
import type { StrategyName } from "./strategy";

export interface RequestMeta {
	id: string;
	method: HttpMethod;
	path: string;
	timestamp: number;
}

/**
 * Standard envelope for all mutation (write) API responses.
 * Every POST/PATCH/DELETE handler returns this shape.
 */
export interface MutationResult<TData = undefined> {
	success: boolean;
	message: string;
	data?: TData;
}

// Retention and maintenance API shapes
export interface RetentionGetResponse {
	payloadDays: number;
	requestDays: number;
}

export interface RetentionSetRequest {
	payloadDays?: number;
	requestDays?: number;
}

export interface CleanupResponse {
	status: "accepted" | "already_running";
}

// Auth/OAuth API shapes
export type AuthSessionStatus = "pending" | "completed" | "expired";

export interface AuthSessionStatusResponse {
	status: AuthSessionStatus;
}

export interface AuthInitData {
	authUrl: string;
	sessionId: string;
	provider: OAuthProvider;
}

export interface AuthCompleteData {
	provider: OAuthProvider;
}

// Account mutation data shapes
export interface AccountCreateData {
	accountId: string;
	weight: number;
	authMethod: AuthMethod;
}

export interface AccountUpdateData {
	accountId: string;
	name: string;
	baseUrl: string | null;
}

export interface AccountDeleteData {
	accountId: string;
}

export interface AccountPauseData {
	paused: boolean;
}

export interface AccountRenameData {
	newName: string;
}

export interface StrategyResponse {
	strategy: StrategyName;
}
