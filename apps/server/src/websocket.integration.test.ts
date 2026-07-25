import { afterEach, describe, expect, it } from "bun:test";
import { requestEvents } from "@ccflare/core";
import {
	handleWebSocketUpgradeRequest,
	type IncomingWorkerMessage,
	type WebSocketProxyData,
	websocketProxyHandler,
} from "@ccflare/proxy";
import type { RequestStreamEvent } from "@ccflare/types";
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

afterEach(async () => {
	globalThis.WebSocket = OriginalWebSocket;
	FakeUpstreamWebSocket.reset();
});

describe("WebSocket proxy behavior", () => {
	it("prepares websocket upgrades and proxies messages bidirectionally", async () => {
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;

		const ctx = createInMemoryProxyContext([createCodexAccount()]);
		const url = new URL("http://localhost:8080/v1/codex/responses");
		let upgradeOptions:
			| {
					headers?: HeadersInit;
					data: WebSocketProxyData;
			  }
			| undefined;
		const upgradeResponse = handleWebSocketUpgradeRequest(
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
					upgradeOptions = options as {
						headers?: HeadersInit;
						data: WebSocketProxyData;
					};
					return true;
				},
			} as unknown as Bun.Server<WebSocketProxyData>,
		);

		expect(upgradeResponse).toBeUndefined();
		expect(upgradeOptions?.headers).toEqual({
			"Sec-WebSocket-Protocol": "realtime",
		});

		const downstream = new FakeServerWebSocket(
			upgradeOptions?.data as WebSocketProxyData,
		);
		websocketProxyHandler.open?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
		);
		websocketProxyHandler.message(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			'{"type":"response.create","input":"hello"}',
		);

		const capture = await waitFor(
			() => Promise.resolve(FakeUpstreamWebSocket.captures[0] ?? null),
			(value): value is FakeUpstreamCapture => value !== null,
		);

		expect(capture.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
		expect(capture.headers.authorization).toBe("Bearer codex-access-token");
		expect(capture.headers.originator).toBe("codex_cli_rs");
		expect(capture.headers["user-agent"]).toContain("codex_cli_rs/");
		expect(capture.headers.version).toBe("0.144.1");
		expect(capture.headers["openai-beta"]).toBe("responses=experimental");
		expect(capture.headers["chatgpt-account-id"]).toBe("acct_123");
		expect(capture.headers["x-client-request-id"]).toBe("req_123");
		expect(capture.headers["x-codex-turn-metadata"]).toBe('{"turn":1}');
		expect(capture.headers.session_id).toBe("session_123");
		expect(capture.headers["sec-websocket-extensions"]).toContain(
			"permessage-deflate",
		);
		expect(capture.headers["sec-websocket-key"]).toBeUndefined();
		expect(capture.headers["sec-websocket-version"]).toBeUndefined();
		expect(capture.protocols).toEqual(["realtime"]);

		const upstreamMessage = await waitFor(
			() => Promise.resolve(capture.sent[0] ?? null),
			(value): value is string | Uint8Array | ArrayBuffer => value !== null,
		);
		expect(decodeMessageData(upstreamMessage)).toBe(
			'{"type":"response.create","input":"hello"}',
		);

		capture.socket.emitMessage('{"type":"response.created","id":"resp_123"}');
		await waitFor(
			() => Promise.resolve(downstream.sentTexts[0] ?? null),
			(value): value is string => value !== null,
		);
		expect(downstream.sentTexts[0]).toBe(
			'{"type":"response.created","id":"resp_123"}',
		);

		capture.socket.close(1000, "finished");
		await waitFor(
			() => Promise.resolve(downstream.closeCalls[0] ?? null),
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

		const ctx = createInMemoryProxyContext([createCodexAccount()]);
		const url = new URL("http://localhost:8080/v1/codex/responses");
		let upgradeOptions:
			| {
					headers?: HeadersInit;
					data: WebSocketProxyData;
			  }
			| undefined;
		handleWebSocketUpgradeRequest(
			new Request(url, {
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
				},
			}),
			url,
			ctx,
			{
				upgrade(
					_request: Request,
					options?: { headers?: HeadersInit; data?: WebSocketProxyData },
				) {
					upgradeOptions = options as {
						headers?: HeadersInit;
						data: WebSocketProxyData;
					};
					return true;
				},
			} as unknown as Bun.Server<WebSocketProxyData>,
		);

		const downstream = new FakeServerWebSocket(
			upgradeOptions?.data as WebSocketProxyData,
		);
		websocketProxyHandler.open?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
		);

		const capture = await waitFor(
			() => Promise.resolve(FakeUpstreamWebSocket.captures[0] ?? null),
			(value): value is FakeUpstreamCapture => value !== null,
		);

		websocketProxyHandler.close?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			1000,
			"client closed",
		);

		await waitFor(
			() => Promise.resolve(capture.closeEvents[0] ?? null),
			(value): value is { code: number; reason: string } => value !== null,
		);
		expect(capture.closeEvents[0]).toMatchObject({
			code: 1000,
			reason: "client closed",
		});
	});

	it("tracks websocket turns for usage logging and finalizes incomplete turns on close", async () => {
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;

		const usageMessages: IncomingWorkerMessage[] = [];
		const requestEventsSeen: RequestStreamEvent[] = [];
		const requestEventHandler = (event: RequestStreamEvent) => {
			requestEventsSeen.push(event);
		};
		requestEvents.on("event", requestEventHandler);

		try {
			const ctx = createInMemoryProxyContext(
				[createCodexAccount()],
				usageMessages,
			);
			const url = new URL("http://localhost:8080/v1/codex/responses");
			let upgradeOptions:
				| {
						headers?: HeadersInit;
						data: WebSocketProxyData;
				  }
				| undefined;
			handleWebSocketUpgradeRequest(
				new Request(url, {
					method: "GET",
					headers: {
						connection: "Upgrade",
						upgrade: "websocket",
					},
				}),
				url,
				ctx,
				{
					upgrade(
						_request: Request,
						options?: { headers?: HeadersInit; data?: WebSocketProxyData },
					) {
						upgradeOptions = options as {
							headers?: HeadersInit;
							data: WebSocketProxyData;
						};
						return true;
					},
				} as unknown as Bun.Server<WebSocketProxyData>,
			);

			const downstream = new FakeServerWebSocket(
				upgradeOptions?.data as WebSocketProxyData,
			);
			websocketProxyHandler.open?.(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			);

			const capture = await waitFor(
				() => Promise.resolve(FakeUpstreamWebSocket.captures[0] ?? null),
				(value): value is FakeUpstreamCapture => value !== null,
			);

			websocketProxyHandler.message(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
				'{"type":"response.create","model":"gpt-4o","input":"hello"}',
			);

			await waitFor(
				() => Promise.resolve(capture.sent.length),
				(length) => length > 0,
			);

			capture.socket.emitMessage(
				'{"type":"response.created","response":{"id":"resp_1","model":"gpt-4o"}}',
			);
			capture.socket.emitMessage(
				'{"type":"response.output_text.delta","delta":"Hello"}',
			);
			capture.socket.emitMessage(
				'{"type":"response.completed","response":{"id":"resp_1","model":"gpt-4o","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
			);

			await waitFor(
				() =>
					Promise.resolve(
						usageMessages.filter((message) => message.type === "end").length,
					),
				(count) => count === 1,
			);

			expect(usageMessages[0]).toMatchObject({
				type: "start",
				method: "WS",
				path: "/v1/codex/responses",
				upstreamPath: "/responses",
				providerName: "codex",
				accountId: "codex-account",
				responseStatus: 101,
				isStream: true,
			});
			expect(
				Buffer.from(
					(
						usageMessages[0] as Extract<
							IncomingWorkerMessage,
							{ type: "start" }
						>
					).requestBody as string,
					"base64",
				).toString("utf8"),
			).toBe('{"type":"response.create","model":"gpt-4o","input":"hello"}');
			expect(
				usageMessages
					.filter((message) => message.type === "chunk")
					.map((message) =>
						new TextDecoder().decode(
							(message as Extract<IncomingWorkerMessage, { type: "chunk" }>)
								.data,
						),
					),
			).toEqual([
				[
					"event: response.created",
					'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-4o"}}',
					"",
					"",
				].join("\n"),
				[
					"event: response.output_text.delta",
					'data: {"type":"response.output_text.delta","delta":"Hello"}',
					"",
					"",
				].join("\n"),
				[
					"event: response.completed",
					'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-4o","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
					"",
					"",
				].join("\n"),
			]);
			expect(usageMessages[usageMessages.length - 1]).toMatchObject({
				type: "end",
				success: true,
			});
			expect(requestEventsSeen).toContainEqual(
				expect.objectContaining({
					type: "start",
					method: "WS",
					path: "/v1/codex/responses",
					statusCode: 101,
				}),
			);

			websocketProxyHandler.message(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
				'{"type":"response.create","model":"gpt-4o","input":"unfinished"}',
			);
			await waitFor(
				() => Promise.resolve(capture.sent.length),
				(length) => length > 1,
			);

			capture.socket.emitMessage(
				'{"type":"response.created","response":{"id":"resp_2","model":"gpt-4o"}}',
			);
			await waitFor(
				() =>
					Promise.resolve(
						usageMessages.filter((message) => message.type === "start").length,
					),
				(count) => count === 2,
			);

			websocketProxyHandler.close?.(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
				1001,
				"client closed mid-turn",
			);

			await waitFor(
				() =>
					Promise.resolve(
						usageMessages.filter((message) => message.type === "end").length,
					),
				(count) => count === 2,
			);
			expect(usageMessages[usageMessages.length - 1]).toMatchObject({
				type: "end",
				success: false,
				error: "client closed mid-turn",
			});
		} finally {
			requestEvents.off("event", requestEventHandler);
		}
	});
});
