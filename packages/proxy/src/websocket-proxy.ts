import { estimateCostUSD, requestEvents } from "@ccflare/core";
import { sanitizeRequestHeaders } from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import type { Account, AccountProvider } from "@ccflare/types";
import {
	extractClientSessionIdFromHeaders,
	toRequestSummary,
} from "@ccflare/types";
import { trackProxyBackgroundTask } from "./background-tasks";
import { selectAccountsForRequest } from "./handlers/account-selector";
import type {
	ProxyContext,
	ResolvedProxyContext,
} from "./handlers/proxy-types";
import { resolveProxyContext } from "./handlers/proxy-types";
import { createRequestMetadata } from "./handlers/request-handler";
import { getValidAccessToken } from "./handlers/token-manager";
import { normalizeOpenAIUsage, parseOpenAIUsagePayload } from "./openai-usage";

const log = new Logger("WebSocketProxy");
const CONNECT_TIMEOUT_MS = 5_000;
const PENDING_MESSAGE_LIMIT = 128;
const CLOSE_CODE_NORMAL = 1_000;
const CLOSE_CODE_INTERNAL_ERROR = 1_011;
const CLOSE_CODE_TRY_AGAIN_LATER = 1_013;

type WebSocketMessageData = string | Uint8Array | ArrayBuffer;

type WebSocketUsageAggregate = {
	models: Set<string>;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	costPromises: Promise<number>[];
};

export interface WebSocketProxyPlan {
	account: Account | null;
	accountName: string | null;
	targetUrl: string;
	headers: Record<string, string>;
	protocols: string[];
}

export interface WebSocketProxySession {
	requestId: string;
	sessionId: string;
	openedAt: number;
	path: string;
	providerName: AccountProvider;
	upstreamPath: string;
	query: string;
	requestHeaders: Record<string, string>;
	requestContext: ResolvedProxyContext;
	candidateAccounts: Array<Account | null>;
	nextAccountIndex: number;
	pendingMessages: WebSocketMessageData[];
	upstream: WebSocket | null;
	connectTimeout: ReturnType<typeof setTimeout> | null;
	connecting: boolean;
	downstreamClosed: boolean;
	closed: boolean;
	finalizing: boolean;
	finalized: boolean;
	finalizeAttempts: number;
	connectedAccount: Account | null;
	upstreamMessageChain: Promise<void>;
	usage: WebSocketUsageAggregate;
}

export interface WebSocketProxyData {
	sessionId: string;
}

const websocketSessions = new Map<string, WebSocketProxySession>();

function sanitizeWebSocketRequestHeaders(original: Headers): Headers {
	const headers = new Headers(original);
	for (const name of [
		"connection",
		"content-length",
		"host",
		"sec-websocket-key",
		"sec-websocket-version",
		"upgrade",
	]) {
		headers.delete(name);
	}
	return headers;
}

function getProtocols(headers: Headers): string[] {
	const value = headers.get("sec-websocket-protocol");
	return value
		? value
				.split(",")
				.map((protocol) => protocol.trim())
				.filter(Boolean)
		: [];
}

function toWebSocketUrl(targetUrl: string): string {
	const url = new URL(targetUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

function cloneMessageData(
	message: string | Buffer<ArrayBuffer>,
): WebSocketMessageData {
	return typeof message === "string" ? message : new Uint8Array(message);
}

function normalizeCloseCode(
	code: number | undefined,
	fallback = CLOSE_CODE_INTERNAL_ERROR,
): number {
	return typeof code === "number" &&
		Number.isInteger(code) &&
		code >= CLOSE_CODE_NORMAL &&
		code < 5_000
		? code
		: fallback;
}

function closeDownstream(
	ws: Bun.ServerWebSocket<WebSocketProxyData>,
	code: number,
	reason: string,
): void {
	if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
}

function closeUpstream(
	session: WebSocketProxySession,
	code: number,
	reason: string,
): void {
	const upstream = session.upstream;
	session.upstream = null;
	if (
		upstream &&
		(upstream.readyState === WebSocket.CONNECTING ||
			upstream.readyState === WebSocket.OPEN)
	) {
		upstream.close(code, reason);
	}
}

function clearConnectTimeout(session: WebSocketProxySession): void {
	if (!session.connectTimeout) return;
	clearTimeout(session.connectTimeout);
	session.connectTimeout = null;
}

function recordClientFrame(
	session: WebSocketProxySession,
	message: WebSocketMessageData,
): void {
	try {
		if (typeof message === "string") {
			session.requestContext.websocketRecorder.recordFrame(
				session.requestId,
				"client_to_upstream",
				"text",
				message,
				"utf8",
			);
			return;
		}
		const bytes =
			message instanceof ArrayBuffer
				? new Uint8Array(message.slice(0))
				: new Uint8Array(message).slice();
		session.requestContext.websocketRecorder.recordFrame(
			session.requestId,
			"client_to_upstream",
			"binary",
			Buffer.from(bytes).toString("base64"),
			"base64",
		);
	} catch (error) {
		log.error("Failed to capture downstream WebSocket frame", error);
	}
}

function captureCompletedUsage(
	session: WebSocketProxySession,
	data: string,
): void {
	try {
		const parsed = JSON.parse(data) as Record<string, unknown>;
		if (parsed.type !== "response.completed") return;
		const response =
			parsed.response && typeof parsed.response === "object"
				? (parsed.response as Record<string, unknown>)
				: null;
		if (!response) return;
		const normalized = normalizeOpenAIUsage(
			parseOpenAIUsagePayload(response.usage),
		);
		const model =
			typeof response.model === "string" ? response.model : "unknown";
		const inputTokens =
			normalized.input_tokens ?? normalized.prompt_tokens ?? 0;
		const cacheReadInputTokens = normalized.cache_read_input_tokens ?? 0;
		const cacheCreationInputTokens =
			normalized.cache_creation_input_tokens ?? 0;
		const outputTokens =
			normalized.output_tokens ?? normalized.completion_tokens ?? 0;
		const reasoningTokens = normalized.reasoning_tokens ?? 0;
		const totalTokens =
			normalized.total_tokens ??
			inputTokens +
				cacheReadInputTokens +
				cacheCreationInputTokens +
				outputTokens;
		session.usage.models.add(model);
		session.usage.inputTokens += inputTokens;
		session.usage.cacheReadInputTokens += cacheReadInputTokens;
		session.usage.cacheCreationInputTokens += cacheCreationInputTokens;
		session.usage.outputTokens += outputTokens;
		session.usage.reasoningTokens += reasoningTokens;
		session.usage.totalTokens += totalTokens;
		session.usage.costPromises.push(
			estimateCostUSD(
				model,
				{
					inputTokens,
					cacheReadInputTokens,
					cacheCreationInputTokens,
					outputTokens,
				},
				{ provider: session.providerName },
			),
		);
	} catch {
		// Transcript capture remains authoritative; analytics extraction is best-effort.
	}
}

async function buildUsageSummary(session: WebSocketProxySession) {
	if (session.usage.models.size === 0) return undefined;
	const costs = await Promise.allSettled(session.usage.costPromises);
	const costUsd = costs.reduce(
		(sum, result) => sum + (result.status === "fulfilled" ? result.value : 0),
		0,
	);
	const model =
		session.usage.models.size === 1
			? (session.usage.models.values().next().value ?? "unknown")
			: "multiple";
	return {
		model,
		promptTokens:
			session.usage.inputTokens +
			session.usage.cacheReadInputTokens +
			session.usage.cacheCreationInputTokens,
		completionTokens: session.usage.outputTokens,
		totalTokens: session.usage.totalTokens,
		costUsd,
		inputTokens: session.usage.inputTokens,
		cacheReadInputTokens: session.usage.cacheReadInputTokens,
		cacheCreationInputTokens: session.usage.cacheCreationInputTokens,
		outputTokens: session.usage.outputTokens,
		reasoningTokens: session.usage.reasoningTokens,
	};
}

async function captureAndForwardUpstreamMessage(
	ws: Bun.ServerWebSocket<WebSocketProxyData>,
	session: WebSocketProxySession,
	data: unknown,
	sequence: number | null,
	observedAt: number,
): Promise<void> {
	try {
		if (typeof data === "string") {
			if (sequence !== null) {
				session.requestContext.websocketRecorder.recordReservedFrame(
					session.requestId,
					sequence,
					"upstream_to_client",
					"text",
					data,
					"utf8",
					observedAt,
				);
			}
			captureCompletedUsage(session, data);
			if (ws.readyState === WebSocket.OPEN) ws.sendText(data);
			return;
		}

		let bytes: Uint8Array;
		if (data instanceof Blob) {
			bytes = new Uint8Array(await data.arrayBuffer());
		} else if (data instanceof ArrayBuffer) {
			bytes = new Uint8Array(data.slice(0));
		} else if (ArrayBuffer.isView(data)) {
			bytes = new Uint8Array(
				data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
			);
		} else {
			const text = String(data);
			if (sequence !== null) {
				session.requestContext.websocketRecorder.recordReservedFrame(
					session.requestId,
					sequence,
					"upstream_to_client",
					"text",
					text,
					"utf8",
					observedAt,
				);
			}
			if (ws.readyState === WebSocket.OPEN) ws.sendText(text);
			return;
		}

		if (sequence !== null) {
			session.requestContext.websocketRecorder.recordReservedFrame(
				session.requestId,
				sequence,
				"upstream_to_client",
				"binary",
				Buffer.from(bytes).toString("base64"),
				"base64",
				observedAt,
			);
		}
		if (ws.readyState === WebSocket.OPEN) ws.sendBinary(bytes);
	} catch (error) {
		if (sequence !== null) {
			session.requestContext.websocketRecorder.recordReservedFrame(
				session.requestId,
				sequence,
				"upstream_to_client",
				"text",
				`[frame capture failed: ${error instanceof Error ? error.message : String(error)}]`,
				"utf8",
				observedAt,
			);
		}
		log.error("Failed to capture or forward upstream WebSocket frame", error);
	}
}

function emitFinalSummary(session: WebSocketProxySession): void {
	const request = session.requestContext.dbOps.getRequestWithAccountName(
		session.requestId,
	);
	if (!request) return;
	requestEvents.emit("event", {
		type: "summary",
		payload: {
			...toRequestSummary(request),
			accountName: request.accountName,
		},
	});
}

function scheduleFinalize(
	session: WebSocketProxySession,
	options: { success: boolean; errorMessage: string | null },
): void {
	if (session.finalizing || session.finalized) return;
	session.finalizing = true;
	session.requestContext.websocketRecorder.prepareFinalize(session.requestId);
	const task = session.upstreamMessageChain
		.catch((error) => {
			log.error("WebSocket message chain failed before finalization", error);
		})
		.then(async () => {
			const usage = await buildUsageSummary(session);
			const request = session.requestContext.websocketRecorder.finalize(
				session.requestId,
				{
					success: options.success,
					errorMessage: options.errorMessage,
					responseTimeMs: Math.max(0, Date.now() - session.openedAt),
					usage,
				},
			);
			if (!request) {
				session.finalizeAttempts += 1;
				session.finalizing = false;
				const persisted =
					session.requestContext.dbOps.getRequestWithAccountName(
						session.requestId,
					);
				if (!persisted) {
					session.requestContext.websocketRecorder.discard(session.requestId);
					websocketSessions.delete(session.sessionId);
					return;
				}
				if (session.finalizeAttempts < 3) {
					const retryTask = new Promise<void>((resolve) => {
						const retry = setTimeout(() => {
							scheduleFinalize(session, options);
							resolve();
						}, 250);
						retry.unref?.();
					});
					trackProxyBackgroundTask(retryTask);
				} else {
					// The recorder retains the unflushed chunk for its shutdown retry,
					// but the closed transport session itself need not remain reachable.
					websocketSessions.delete(session.sessionId);
				}
				return;
			}
			emitFinalSummary(session);
			session.finalized = true;
			session.finalizing = false;
			websocketSessions.delete(session.sessionId);
		});
	trackProxyBackgroundTask(task);
}

async function flushPendingMessages(
	ws: Bun.ServerWebSocket<WebSocketProxyData>,
	session: WebSocketProxySession,
): Promise<void> {
	const upstream = session.upstream;
	if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
	while (
		session.pendingMessages.length > 0 &&
		upstream.readyState === WebSocket.OPEN &&
		ws.readyState === WebSocket.OPEN
	) {
		upstream.send(session.pendingMessages.shift() as WebSocketMessageData);
	}
}

async function buildWebSocketPlan(
	requestHeaders: Headers,
	query: string,
	ctx: ResolvedProxyContext,
	account: Account | null,
): Promise<WebSocketProxyPlan> {
	const sanitizedHeaders = sanitizeWebSocketRequestHeaders(requestHeaders);
	let requestAccount = account;
	if (account) {
		const accessToken = await getValidAccessToken(account, ctx);
		requestAccount =
			accessToken === account.access_token
				? account
				: { ...account, access_token: accessToken };
	}
	const preparedHeaders = ctx.provider.prepareHeaders(
		sanitizedHeaders,
		requestAccount,
	);
	const protocols = getProtocols(preparedHeaders);
	preparedHeaders.delete("sec-websocket-protocol");
	return {
		account,
		accountName: account?.name ?? null,
		targetUrl: toWebSocketUrl(
			ctx.provider.buildUrl(ctx.upstreamPath, query, account ?? undefined),
		),
		headers: Object.fromEntries(preparedHeaders.entries()),
		protocols,
	};
}

async function connectToNextUpstream(
	ws: Bun.ServerWebSocket<WebSocketProxyData>,
): Promise<void> {
	const session = websocketSessions.get(ws.data.sessionId);
	if (
		!session ||
		session.closed ||
		session.downstreamClosed ||
		session.connecting
	) {
		return;
	}
	const account = session.candidateAccounts[session.nextAccountIndex];
	if (account === undefined) {
		session.closed = true;
		session.requestContext.websocketRecorder.recordLifecycle(
			session.requestId,
			"upstream_unavailable",
		);
		scheduleFinalize(session, {
			success: false,
			errorMessage: "Unable to connect to an upstream websocket",
		});
		closeDownstream(
			ws,
			CLOSE_CODE_TRY_AGAIN_LATER,
			"Unable to connect to an upstream websocket",
		);
		return;
	}

	session.nextAccountIndex += 1;
	session.connecting = true;
	session.requestContext.websocketRecorder.recordLifecycle(
		session.requestId,
		"upstream_connect_attempt",
		{ accountId: account?.id ?? null, accountName: account?.name ?? null },
	);

	let plan: WebSocketProxyPlan;
	try {
		plan = await buildWebSocketPlan(
			new Headers(session.requestHeaders),
			session.query,
			session.requestContext,
			account,
		);
	} catch (error) {
		session.connecting = false;
		session.requestContext.websocketRecorder.recordLifecycle(
			session.requestId,
			"upstream_connect_error",
			{ error: error instanceof Error ? error.message : String(error) },
		);
		await connectToNextUpstream(ws);
		return;
	}

	if (session.closed || session.downstreamClosed) {
		session.connecting = false;
		return;
	}

	try {
		const upstream = new (
			WebSocket as unknown as new (
				url: string,
				options: Bun.WebSocketOptions,
			) => WebSocket
		)(plan.targetUrl, { headers: plan.headers, protocols: plan.protocols });
		upstream.binaryType = "arraybuffer";
		session.upstream = upstream;
		let opened = false;
		const timeout = setTimeout(() => {
			if (!opened && upstream.readyState === WebSocket.CONNECTING) {
				upstream.close(
					CLOSE_CODE_TRY_AGAIN_LATER,
					"Upstream websocket connect timeout",
				);
			}
		}, CONNECT_TIMEOUT_MS);
		timeout.unref?.();
		session.connectTimeout = timeout;

		upstream.addEventListener("open", () => {
			opened = true;
			session.connecting = false;
			session.connectedAccount = plan.account;
			clearConnectTimeout(session);
			session.requestContext.dbOps.updateWebSocketRequestAccount(
				session.requestId,
				plan.account?.id ?? null,
			);
			session.requestContext.websocketRecorder.recordLifecycle(
				session.requestId,
				"upstream_connected",
				{ accountId: plan.account?.id ?? null, accountName: plan.accountName },
			);
			if (session.downstreamClosed) {
				closeUpstream(session, CLOSE_CODE_NORMAL, "Downstream closed");
				return;
			}
			void flushPendingMessages(ws, session);
		});

		upstream.addEventListener("message", (event) => {
			const observedAt = Date.now();
			const sequence = session.requestContext.websocketRecorder.reserveSequence(
				session.requestId,
			);
			session.upstreamMessageChain = session.upstreamMessageChain.then(() =>
				captureAndForwardUpstreamMessage(
					ws,
					session,
					event.data,
					sequence,
					observedAt,
				),
			);
		});

		upstream.addEventListener("close", (event) => {
			session.connecting = false;
			clearConnectTimeout(session);
			if (session.upstream === upstream) session.upstream = null;
			if (!opened && !session.downstreamClosed) {
				session.requestContext.websocketRecorder.recordLifecycle(
					session.requestId,
					"upstream_connect_closed",
					{ code: event.code, reason: event.reason },
				);
				void connectToNextUpstream(ws);
				return;
			}
			session.requestContext.websocketRecorder.recordLifecycle(
				session.requestId,
				"upstream_closed",
				{ code: event.code, reason: event.reason },
			);
			if (!session.downstreamClosed) {
				session.closed = true;
				scheduleFinalize(session, {
					success: event.code === CLOSE_CODE_NORMAL,
					errorMessage:
						event.code === CLOSE_CODE_NORMAL
							? null
							: event.reason || "Upstream websocket closed",
				});
				closeDownstream(
					ws,
					normalizeCloseCode(event.code, CLOSE_CODE_NORMAL),
					event.reason || "Upstream websocket closed",
				);
			}
		});

		upstream.addEventListener("error", () => {
			session.requestContext.websocketRecorder.recordLifecycle(
				session.requestId,
				"upstream_error",
				{ accountName: plan.accountName },
			);
			log.warn("Upstream websocket error", {
				account: plan.accountName,
				provider: session.providerName,
				path: session.path,
			});
		});
	} catch (error) {
		session.connecting = false;
		clearConnectTimeout(session);
		session.requestContext.websocketRecorder.recordLifecycle(
			session.requestId,
			"upstream_create_error",
			{ error: error instanceof Error ? error.message : String(error) },
		);
		await connectToNextUpstream(ws);
	}
}

export function isWebSocketUpgradeRequest(req: Request): boolean {
	if (req.method !== "GET") return false;
	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return false;
	const connection = req.headers.get("connection");
	return (
		!connection ||
		connection
			.toLowerCase()
			.split(",")
			.some((value) => value.trim() === "upgrade")
	);
}

export function handleWebSocketUpgradeRequest(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	server: Bun.Server<WebSocketProxyData>,
): Response | undefined {
	if (!isWebSocketUpgradeRequest(req)) return undefined;
	const requestContext = resolveProxyContext(url, ctx);
	if (!requestContext) return new Response("Not Found", { status: 404 });
	if (
		!requestContext.provider.supportsWebSocket?.(requestContext.upstreamPath)
	) {
		return new Response("WebSocket upgrades are not supported for this route", {
			status: 400,
		});
	}

	const requestMeta = createRequestMetadata(req, url);
	const accounts = selectAccountsForRequest(requestMeta, requestContext);
	const protocols = getProtocols(req.headers);
	const sessionId = crypto.randomUUID();
	const session: WebSocketProxySession = {
		requestId: crypto.randomUUID(),
		sessionId,
		openedAt: Date.now(),
		path: url.pathname,
		providerName: requestContext.providerName,
		upstreamPath: requestContext.upstreamPath,
		query: url.search,
		requestHeaders: Object.fromEntries(
			sanitizeRequestHeaders(req.headers).entries(),
		),
		requestContext,
		candidateAccounts: accounts.length > 0 ? accounts : [null],
		nextAccountIndex: 0,
		pendingMessages: [],
		upstream: null,
		connectTimeout: null,
		connecting: false,
		downstreamClosed: false,
		closed: false,
		finalizing: false,
		finalized: false,
		finalizeAttempts: 0,
		connectedAccount: null,
		upstreamMessageChain: Promise.resolve(),
		usage: {
			models: new Set(),
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			totalTokens: 0,
			costPromises: [],
		},
	};
	websocketSessions.set(sessionId, session);
	const upgraded = server.upgrade(req, {
		headers:
			protocols[0] !== undefined
				? { "Sec-WebSocket-Protocol": protocols[0] }
				: undefined,
		data: { sessionId },
	});
	if (!upgraded) {
		websocketSessions.delete(sessionId);
		return new Response("WebSocket upgrade failed", { status: 400 });
	}
	return undefined;
}

export function closeAllWebSocketProxySessions(): void {
	for (const session of websocketSessions.values()) {
		if (session.finalized || session.finalizing) continue;
		session.closed = true;
		session.downstreamClosed = true;
		clearConnectTimeout(session);
		session.requestContext.websocketRecorder.recordLifecycle(
			session.requestId,
			"server_shutdown",
		);
		closeUpstream(session, CLOSE_CODE_TRY_AGAIN_LATER, "Server shutdown");
		scheduleFinalize(session, {
			success: false,
			errorMessage: "WebSocket interrupted by server shutdown",
		});
	}
}

export const websocketProxyHandler: Bun.WebSocketHandler<WebSocketProxyData> = {
	open(ws) {
		const session = websocketSessions.get(ws.data.sessionId);
		if (!session) return;
		try {
			session.requestContext.dbOps.saveRequestMeta(
				session.requestId,
				"WS",
				session.path,
				session.providerName,
				session.upstreamPath,
				null,
				101,
				session.openedAt,
			);
			const clientSessionId = extractClientSessionIdFromHeaders(
				session.requestHeaders,
			);
			session.requestContext.dbOps.updateWebSocketClientSessionId(
				session.requestId,
				clientSessionId,
			);
			session.requestContext.websocketRecorder.start(session.requestId);
			session.requestContext.websocketRecorder.recordLifecycle(
				session.requestId,
				"connection_open",
				{
					path: session.path,
					provider: session.providerName,
					headers: session.requestHeaders,
				},
			);
			requestEvents.emit("event", {
				type: "start",
				id: session.requestId,
				timestamp: session.openedAt,
				method: "WS",
				path: session.path,
				accountId: null,
				accountName: null,
				statusCode: 101,
				clientSessionId,
			});
			void connectToNextUpstream(ws);
		} catch (error) {
			log.error("Failed to initialize WebSocket request history", error);
			session.closed = true;
			session.requestContext.websocketRecorder.discard(session.requestId);
			websocketSessions.delete(session.sessionId);
			closeDownstream(
				ws,
				CLOSE_CODE_INTERNAL_ERROR,
				"Failed to initialize request history",
			);
		}
	},
	message(ws, message) {
		const session = websocketSessions.get(ws.data.sessionId);
		if (!session) return;
		const captured = cloneMessageData(message);
		recordClientFrame(session, captured);
		if (session.closed || session.downstreamClosed) {
			session.requestContext.websocketRecorder.recordLifecycle(
				session.requestId,
				"frame_not_forwarded",
				{ reason: "connection_closed" },
			);
			return;
		}
		if (session.upstream?.readyState === WebSocket.OPEN) {
			session.upstream.send(message);
			return;
		}
		if (session.pendingMessages.length >= PENDING_MESSAGE_LIMIT) {
			session.closed = true;
			session.requestContext.websocketRecorder.recordLifecycle(
				session.requestId,
				"pending_queue_exhausted",
			);
			scheduleFinalize(session, {
				success: false,
				errorMessage: "Downstream message queue limit reached",
			});
			closeUpstream(
				session,
				CLOSE_CODE_TRY_AGAIN_LATER,
				"Downstream message queue limit reached",
			);
			closeDownstream(
				ws,
				CLOSE_CODE_TRY_AGAIN_LATER,
				"Upstream websocket is not ready",
			);
			return;
		}
		session.pendingMessages.push(captured);
	},
	close(ws, code, reason) {
		const session = websocketSessions.get(ws.data.sessionId);
		if (!session) return;
		session.downstreamClosed = true;
		session.closed = true;
		session.pendingMessages.length = 0;
		clearConnectTimeout(session);
		session.requestContext.websocketRecorder.recordLifecycle(
			session.requestId,
			"downstream_closed",
			{ code, reason },
		);
		closeUpstream(
			session,
			normalizeCloseCode(code, CLOSE_CODE_NORMAL),
			reason || "Downstream websocket closed",
		);
		scheduleFinalize(session, {
			success: code === CLOSE_CODE_NORMAL,
			errorMessage:
				code === CLOSE_CODE_NORMAL
					? null
					: reason || "Downstream websocket closed",
		});
	},
};
