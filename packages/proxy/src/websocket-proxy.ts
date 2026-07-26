import { requestEvents } from "@ccflare/core";
import { sanitizeRequestHeaders } from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import type { Account, AccountProvider } from "@ccflare/types";
import { extractClientSessionIdFromHeaders } from "@ccflare/types";
import { selectAccountsForRequest } from "./handlers/account-selector";
import type {
	ProxyContext,
	ResolvedProxyContext,
} from "./handlers/proxy-types";
import { resolveProxyContext } from "./handlers/proxy-types";
import { createRequestMetadata } from "./handlers/request-handler";
import { getValidAccessToken } from "./handlers/token-manager";
import { normalizeOpenAIUsage, type OpenAIUsagePayload } from "./openai-usage";
import type {
	ChunkMessage,
	EndMessage,
	PreExtractedUsage,
	StartMessage,
} from "./worker-messages";

const log = new Logger("WebSocketProxy");
const CONNECT_TIMEOUT_MS = 5_000;
const PENDING_MESSAGE_LIMIT = 128;
const CLOSE_CODE_NORMAL = 1_000;
const CLOSE_CODE_INTERNAL_ERROR = 1_011;
const CLOSE_CODE_TRY_AGAIN_LATER = 1_013;

type WebSocketMessageData = string | Uint8Array | ArrayBuffer;
type WebSocketTurnState = {
	requestId: string;
	timestamp: number;
	model?: string;
	usage?: PreExtractedUsage;
};

export interface WebSocketProxyPlan {
	account: Account | null;
	accountName: string | null;
	targetUrl: string;
	headers: Record<string, string>;
	protocols: string[];
}

export interface WebSocketProxySession {
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
	activeTurn: WebSocketTurnState | null;
	connectedAccount: Account | null;
	pendingRequestBody: string | null;
	pendingRequestTimestamp: number | null;
}

export interface WebSocketProxyData {
	sessionId: string;
}

const websocketSessions = new Map<string, WebSocketProxySession>();
const textEncoder = new TextEncoder();

function sanitizeWebSocketRequestHeaders(original: Headers): Headers {
	const headers = new Headers(original);

	headers.delete("connection");
	headers.delete("content-length");
	headers.delete("host");
	headers.delete("sec-websocket-key");
	headers.delete("sec-websocket-version");
	headers.delete("upgrade");

	return headers;
}

function getProtocols(headers: Headers): string[] {
	const value = headers.get("sec-websocket-protocol");
	if (!value) {
		return [];
	}

	return value
		.split(",")
		.map((protocol) => protocol.trim())
		.filter(Boolean);
}

function toWebSocketUrl(targetUrl: string): string {
	const url = new URL(targetUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

function cloneMessageData(
	message: string | Buffer<ArrayBuffer>,
): WebSocketMessageData {
	if (typeof message === "string") {
		return message;
	}

	return new Uint8Array(message);
}

function normalizeCloseCode(
	code: number | undefined,
	fallback = CLOSE_CODE_INTERNAL_ERROR,
): number {
	if (typeof code !== "number" || !Number.isInteger(code)) {
		return fallback;
	}

	if (code === 0 || code < CLOSE_CODE_NORMAL || code >= 5_000) {
		return fallback;
	}

	return code;
}

function closeDownstream(
	ws: Bun.ServerWebSocket<WebSocketProxyData>,
	code: number,
	reason: string,
): void {
	if (ws.readyState === WebSocket.OPEN) {
		ws.close(code, reason);
	}
}

function closeUpstream(
	session: WebSocketProxySession,
	code: number,
	reason: string,
): void {
	const upstream = session.upstream;
	session.upstream = null;

	if (!upstream) {
		return;
	}

	if (
		upstream.readyState === WebSocket.CONNECTING ||
		upstream.readyState === WebSocket.OPEN
	) {
		upstream.close(code, reason);
	}
}

function clearConnectTimeout(session: WebSocketProxySession): void {
	if (session.connectTimeout) {
		clearTimeout(session.connectTimeout);
		session.connectTimeout = null;
	}
}

function parseWebSocketJsonMessage(
	data: string,
): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(data);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function getMessageType(parsed: Record<string, unknown>): string | null {
	return typeof parsed.type === "string" ? parsed.type : null;
}

function getEventModel(parsed: Record<string, unknown>): string | undefined {
	const response =
		parsed.response && typeof parsed.response === "object"
			? (parsed.response as Record<string, unknown>)
			: null;

	if (response && typeof response.model === "string") {
		return response.model;
	}

	return typeof parsed.model === "string" ? parsed.model : undefined;
}

function getResponseCompletedUsage(
	parsed: Record<string, unknown>,
): PreExtractedUsage | undefined {
	const response =
		parsed.response && typeof parsed.response === "object"
			? (parsed.response as Record<string, unknown>)
			: null;
	const usage =
		response?.usage && typeof response.usage === "object"
			? (response.usage as Record<string, unknown>)
			: null;

	if (!usage) {
		return undefined;
	}

	const preExtractedUsage = normalizeOpenAIUsage(usage as OpenAIUsagePayload);

	return Object.keys(preExtractedUsage).length > 0
		? preExtractedUsage
		: undefined;
}

function createSyntheticSseChunk(
	eventType: string,
	payload: string,
): Uint8Array {
	return textEncoder.encode(`event: ${eventType}\ndata: ${payload}\n\n`);
}

function emitTurnStartEvent(
	session: WebSocketProxySession,
	requestId: string,
	timestamp: number,
): void {
	requestEvents.emit("event", {
		type: "start",
		id: requestId,
		timestamp,
		method: "WS",
		path: session.path,
		accountId: session.connectedAccount?.id ?? null,
		statusCode: 101,
		clientSessionId: extractClientSessionIdFromHeaders(session.requestHeaders),
	});
}

function endActiveTurn(
	session: WebSocketProxySession,
	success: boolean,
	error?: string,
): void {
	const activeTurn = session.activeTurn;
	if (!activeTurn) {
		return;
	}

	log.debug("Ending tracked websocket turn", {
		requestId: activeTurn.requestId,
		provider: session.providerName,
		path: session.path,
		model: activeTurn.model ?? null,
		success,
		error: error ?? null,
		account: session.connectedAccount?.name ?? null,
	});

	const endMessage: EndMessage = {
		type: "end",
		requestId: activeTurn.requestId,
		preExtractedUsage: activeTurn.usage,
		preExtractedModel: activeTurn.model,
		success,
	};
	if (error) {
		endMessage.error = error;
	}
	session.requestContext.usageWorker.postMessage(endMessage);
	session.activeTurn = null;
}

function startActiveTurn(
	session: WebSocketProxySession,
	messageType: string,
	messageData: string,
	parsed: Record<string, unknown>,
): void {
	if (messageType !== "response.created") {
		return;
	}

	if (session.activeTurn) {
		endActiveTurn(
			session,
			false,
			"WebSocket turn was replaced before response.completed",
		);
	}

	const requestId = crypto.randomUUID();
	const timestamp = session.pendingRequestTimestamp ?? Date.now();
	const startMessage: StartMessage = {
		type: "start",
		requestId,
		accountId: session.connectedAccount?.id ?? null,
		method: "WS",
		path: session.path,
		upstreamPath: session.upstreamPath,
		timestamp,
		requestHeaders: session.requestHeaders,
		requestBody: session.pendingRequestBody,
		responseStatus: 101,
		responseHeaders: {},
		isStream: true,
		providerName: session.providerName,
		retryAttempt: 0,
		failoverAttempts: Math.max(0, session.nextAccountIndex - 1),
	};

	session.activeTurn = {
		requestId,
		timestamp,
		model: getEventModel(parsed),
	};
	log.debug("Starting tracked websocket turn", {
		requestId,
		provider: session.providerName,
		path: session.path,
		upstreamPath: session.upstreamPath,
		messageType,
		model: session.activeTurn.model ?? null,
		account: session.connectedAccount?.name ?? null,
		hasPendingRequestBody: session.pendingRequestBody !== null,
	});
	session.pendingRequestBody = null;
	session.pendingRequestTimestamp = null;
	session.requestContext.usageWorker.postMessage(startMessage);
	emitTurnStartEvent(session, requestId, timestamp);

	const chunkMessage: ChunkMessage = {
		type: "chunk",
		requestId,
		data: createSyntheticSseChunk(messageType, messageData),
	};
	session.requestContext.usageWorker.postMessage(chunkMessage);
}

function handleTrackedUpstreamText(
	session: WebSocketProxySession,
	data: string,
): void {
	const parsed = parseWebSocketJsonMessage(data);
	if (!parsed) {
		return;
	}

	const messageType = getMessageType(parsed);
	if (!messageType) {
		return;
	}

	log.debug("Processing tracked websocket message", {
		provider: session.providerName,
		path: session.path,
		messageType,
		activeRequestId: session.activeTurn?.requestId ?? null,
		activeModel: session.activeTurn?.model ?? null,
	});

	startActiveTurn(session, messageType, data, parsed);

	const activeTurn = session.activeTurn;
	if (!activeTurn) {
		return;
	}

	if (!activeTurn.model) {
		activeTurn.model = getEventModel(parsed);
	}

	if (messageType === "response.completed") {
		activeTurn.usage = getResponseCompletedUsage(parsed);
		activeTurn.model = getEventModel(parsed) ?? activeTurn.model;
	}

	if (messageType !== "response.created") {
		const chunkMessage: ChunkMessage = {
			type: "chunk",
			requestId: activeTurn.requestId,
			data: createSyntheticSseChunk(messageType, data),
		};
		session.requestContext.usageWorker.postMessage(chunkMessage);
	}

	if (messageType === "response.completed") {
		endActiveTurn(session, true);
	}
}

function capturePendingRequestBody(
	session: WebSocketProxySession,
	message: WebSocketMessageData,
): void {
	if (typeof message !== "string") {
		return;
	}

	const parsed = parseWebSocketJsonMessage(message);
	if (!parsed || getMessageType(parsed) !== "response.create") {
		return;
	}

	session.pendingRequestBody = Buffer.from(message).toString("base64");
	session.pendingRequestTimestamp = Date.now();
	log.debug("Captured websocket request body for next tracked turn", {
		provider: session.providerName,
		path: session.path,
		size: message.length,
	});
}

async function forwardUpstreamMessage(
	ws: Bun.ServerWebSocket<WebSocketProxyData>,
	session: WebSocketProxySession,
	data: unknown,
): Promise<void> {
	if (ws.readyState !== WebSocket.OPEN) {
		return;
	}

	if (typeof data === "string") {
		handleTrackedUpstreamText(session, data);
		ws.sendText(data);
		return;
	}

	if (data instanceof Blob) {
		ws.sendBinary(await data.arrayBuffer());
		return;
	}

	if (data instanceof ArrayBuffer) {
		ws.sendBinary(data);
		return;
	}

	if (ArrayBuffer.isView(data)) {
		ws.sendBinary(data as unknown as Bun.BufferSource);
		return;
	}

	ws.sendText(String(data));
}

async function flushPendingMessages(
	ws: Bun.ServerWebSocket<WebSocketProxyData>,
	session: WebSocketProxySession,
): Promise<void> {
	const upstream = session.upstream;
	if (!upstream || upstream.readyState !== WebSocket.OPEN) {
		return;
	}

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
	if (!session) {
		return;
	}
	if (session.closed || session.downstreamClosed || session.connecting) {
		return;
	}

	const account = session.candidateAccounts[session.nextAccountIndex];
	if (account === undefined) {
		session.closed = true;
		closeDownstream(
			ws,
			CLOSE_CODE_TRY_AGAIN_LATER,
			"Unable to connect to an upstream websocket",
		);
		return;
	}

	session.nextAccountIndex += 1;
	session.connecting = true;

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
		log.warn("Skipping websocket account during upstream connection", {
			account: account?.name ?? null,
			error: error instanceof Error ? error.message : String(error),
		});
		await connectToNextUpstream(ws);
		return;
	}

	if (session.closed || session.downstreamClosed) {
		session.connecting = false;
		return;
	}

	try {
		const websocketOptions = {
			headers: plan.headers,
			protocols: plan.protocols,
		};
		const upstream = new (
			WebSocket as unknown as new (
				url: string,
				options: Bun.WebSocketOptions,
			) => WebSocket
		)(plan.targetUrl, websocketOptions);
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

			if (session.downstreamClosed) {
				closeUpstream(session, CLOSE_CODE_NORMAL, "Downstream closed");
				return;
			}

			void flushPendingMessages(ws, session);
		});

		upstream.addEventListener("message", (event) => {
			void forwardUpstreamMessage(ws, session, event.data);
		});

		upstream.addEventListener("close", (event) => {
			session.connecting = false;
			clearConnectTimeout(session);
			session.connectedAccount = null;
			if (session.upstream === upstream) {
				session.upstream = null;
			}

			if (!opened && !session.downstreamClosed) {
				void connectToNextUpstream(ws);
				return;
			}

			if (!session.downstreamClosed) {
				endActiveTurn(
					session,
					false,
					event.reason || "Upstream websocket closed",
				);
				session.closed = true;
				closeDownstream(
					ws,
					normalizeCloseCode(event.code, CLOSE_CODE_NORMAL),
					event.reason || "Upstream websocket closed",
				);
			}
		});

		upstream.addEventListener("error", () => {
			log.warn("Upstream websocket error", {
				account: plan.accountName,
				provider: session.providerName,
				path: session.path,
			});
		});
	} catch (error) {
		session.connecting = false;
		clearConnectTimeout(session);
		log.warn("Failed to create upstream websocket", {
			account: plan.accountName,
			error: error instanceof Error ? error.message : String(error),
		});
		await connectToNextUpstream(ws);
	}
}

export function isWebSocketUpgradeRequest(req: Request): boolean {
	if (req.method !== "GET") {
		return false;
	}

	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return false;
	}

	const connection = req.headers.get("connection");
	if (!connection) {
		return true;
	}

	return connection
		.toLowerCase()
		.split(",")
		.some((value) => value.trim() === "upgrade");
}

export function handleWebSocketUpgradeRequest(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	server: Bun.Server<WebSocketProxyData>,
): Response | undefined {
	if (!isWebSocketUpgradeRequest(req)) {
		return undefined;
	}

	const requestContext = resolveProxyContext(url, ctx);
	if (!requestContext) {
		return new Response("Not Found", { status: 404 });
	}

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
		activeTurn: null,
		connectedAccount: null,
		pendingRequestBody: null,
		pendingRequestTimestamp: null,
	};
	websocketSessions.set(sessionId, session);
	const upgraded = server.upgrade(req, {
		headers:
			protocols[0] !== undefined
				? {
						"Sec-WebSocket-Protocol": protocols[0],
					}
				: undefined,
		data: { sessionId },
	});

	if (!upgraded) {
		websocketSessions.delete(sessionId);
		return new Response("WebSocket upgrade failed", { status: 400 });
	}

	return undefined;
}

export const websocketProxyHandler: Bun.WebSocketHandler<WebSocketProxyData> = {
	open(ws) {
		void connectToNextUpstream(ws);
	},
	message(ws, message) {
		const session = websocketSessions.get(ws.data.sessionId);
		if (!session) {
			return;
		}
		if (session.closed || session.downstreamClosed) {
			return;
		}

		capturePendingRequestBody(session, message);

		if (session.upstream && session.upstream.readyState === WebSocket.OPEN) {
			session.upstream.send(message);
			return;
		}

		if (session.pendingMessages.length >= PENDING_MESSAGE_LIMIT) {
			session.closed = true;
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

		session.pendingMessages.push(cloneMessageData(message));
	},
	close(ws, code, reason) {
		const session = websocketSessions.get(ws.data.sessionId);
		if (!session) {
			return;
		}
		session.downstreamClosed = true;
		session.closed = true;
		session.pendingMessages.length = 0;
		clearConnectTimeout(session);
		session.connectedAccount = null;
		endActiveTurn(session, false, reason || "Downstream websocket closed");
		closeUpstream(
			session,
			normalizeCloseCode(code, CLOSE_CODE_NORMAL),
			reason || "Downstream websocket closed",
		);
		websocketSessions.delete(ws.data.sessionId);
	},
};
