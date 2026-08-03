import { afterEach, describe, expect, it } from "bun:test";
import {
	handleWebSocketUpgradeRequest,
	type WebSocketProxyData,
	websocketProxyHandler,
} from "@ccflare/proxy";
import {
	createCodexAccount,
	createInMemoryProxyContext,
	decodeMessageData,
	FakeServerWebSocket,
	type FakeUpstreamCapture,
	FakeUpstreamWebSocket,
	OriginalWebSocket,
	waitFor,
} from "./test-helpers/websocket";

afterEach(() => {
	globalThis.WebSocket = OriginalWebSocket;
	FakeUpstreamWebSocket.reset();
});

function upgradeTestConnection() {
	const ctx = createInMemoryProxyContext([createCodexAccount()]);
	const url = new URL("http://localhost:8080/v1/codex/responses");
	let upgradeOptions:
		| { headers?: HeadersInit; data?: WebSocketProxyData }
		| undefined;
	const response = handleWebSocketUpgradeRequest(
		new Request(url, {
			method: "GET",
			headers: {
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-protocol": "realtime",
				"Sec-WebSocket-Extensions": "permessage-deflate",
				"chatgpt-account-id": "acct_123",
				"x-client-request-id": "req_123",
				"x-codex-turn-metadata": '{"turn":1}',
				session_id: "session_123",
				"openai-beta": "responses=experimental",
			},
		}),
		url,
		ctx,
		{
			upgrade(
				_request: Request,
				options?: { headers?: HeadersInit; data?: WebSocketProxyData },
			) {
				upgradeOptions = options;
				return true;
			},
		} as unknown as Bun.Server<WebSocketProxyData>,
	);
	const downstream = new FakeServerWebSocket(
		upgradeOptions?.data as WebSocketProxyData,
	);
	return { response, upgradeOptions, downstream };
}

describe("WebSocket proxy behavior", () => {
	it("keeps zero-account upgrades as unauthenticated passthrough candidates", () => {
		const url = new URL("http://localhost:8080/v1/codex/responses");
		let upgraded = false;
		const response = handleWebSocketUpgradeRequest(
			new Request(url, {
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
					authorization: "Bearer caller-credential",
				},
			}),
			url,
			createInMemoryProxyContext([]),
			{
				upgrade() {
					upgraded = true;
					return true;
				},
			} as unknown as Bun.Server<WebSocketProxyData>,
		);

		expect(response).toBeUndefined();
		expect(upgraded).toBe(true);
	});

	it("rejects paused or cooling managed accounts before upgrade", async () => {
		const url = new URL("http://localhost:8080/v1/codex/responses");
		const cases = [
			{ account: { ...createCodexAccount(), paused: true }, status: 503 },
			{
				account: {
					...createCodexAccount(),
					rate_limited_until: Date.now() + 30_000,
				},
				status: 429,
			},
		];

		for (const { account, status } of cases) {
			let upgraded = false;
			const response = handleWebSocketUpgradeRequest(
				new Request(url, {
					method: "GET",
					headers: { connection: "Upgrade", upgrade: "websocket" },
				}),
				url,
				createInMemoryProxyContext([account]),
				{
					upgrade() {
						upgraded = true;
						return true;
					},
				} as unknown as Bun.Server<WebSocketProxyData>,
			);

			expect(response?.status).toBe(status);
			expect(upgraded).toBe(false);
		}
	});

	it("prepares websocket upgrades and proxies messages bidirectionally", async () => {
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;
		const { response, upgradeOptions, downstream } = upgradeTestConnection();
		expect(response).toBeUndefined();
		expect(upgradeOptions?.headers).toEqual({
			"Sec-WebSocket-Protocol": "realtime",
		});

		websocketProxyHandler.open?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
		);
		websocketProxyHandler.message(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			'{"type":"response.create","input":"hello"}',
		);
		const capture = await waitFor(
			() => FakeUpstreamWebSocket.captures[0] ?? null,
			(value): value is FakeUpstreamCapture => value !== null,
		);

		expect(capture.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
		expect(capture.headers.authorization).toBe("Bearer codex-access-token");
		expect(capture.headers.originator).toBe("codex_cli_rs");
		expect(capture.headers["openai-beta"]).toBe("responses=experimental");
		expect(capture.headers["chatgpt-account-id"]).toBe("acct_123");
		expect(capture.headers["x-client-request-id"]).toBe("req_123");
		expect(capture.headers["x-codex-turn-metadata"]).toBe('{"turn":1}');
		expect(capture.headers.session_id).toBe("session_123");
		expect(capture.protocols).toEqual(["realtime"]);

		const upstreamMessage = await waitFor(
			() => capture.sent[0] ?? null,
			(value): value is string | Uint8Array | ArrayBuffer => value !== null,
		);
		expect(decodeMessageData(upstreamMessage)).toBe(
			'{"type":"response.create","input":"hello"}',
		);

		capture.socket.emitMessage('{"type":"response.created","id":"resp_123"}');
		await waitFor(
			() => downstream.sentTexts[0] ?? null,
			(value): value is string => value !== null,
		);
		expect(downstream.sentTexts[0]).toBe(
			'{"type":"response.created","id":"resp_123"}',
		);

		capture.socket.close(1000, "finished");
		await waitFor(
			() => downstream.closeCalls[0] ?? null,
			(value): value is { code: number; reason: string } => value !== null,
		);
		expect(downstream.closeCalls[0]).toMatchObject({
			code: 1000,
			reason: "finished",
		});
	});

	it("closes the upstream websocket when the downstream client disconnects", async () => {
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;
		const { downstream } = upgradeTestConnection();
		websocketProxyHandler.open?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
		);
		const capture = await waitFor(
			() => FakeUpstreamWebSocket.captures[0] ?? null,
			(value): value is FakeUpstreamCapture => value !== null,
		);
		websocketProxyHandler.close?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			1000,
			"client closed",
		);
		await waitFor(
			() => capture.closeEvents[0] ?? null,
			(value): value is { code: number; reason: string } => value !== null,
		);
		expect(capture.closeEvents[0]).toMatchObject({
			code: 1000,
			reason: "client closed",
		});
	});
});
