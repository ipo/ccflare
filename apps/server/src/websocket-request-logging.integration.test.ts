import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestEvents } from "@ccflare/core";
import { DatabaseFactory } from "@ccflare/database";
import { CodexProvider, ProviderRegistry } from "@ccflare/providers";
import {
	handleWebSocketUpgradeRequest,
	type ProxyContext,
	type WebSocketProxyData,
	WebSocketTranscriptRecorder,
	websocketProxyHandler,
} from "@ccflare/proxy";
import type {
	Account,
	Request,
	RequestStreamEvent,
	WebSocketTranscriptEntry,
} from "@ccflare/types";
import {
	createCodexAccount,
	decodeMessageData,
	FakeServerWebSocket,
	type FakeUpstreamCapture,
	FakeUpstreamWebSocket,
	OriginalWebSocket,
	waitFor,
} from "./test-helpers/websocket";

let tempDir: string | null = null;
let recorder: WebSocketTranscriptRecorder | null = null;

afterEach(() => {
	recorder?.dispose();
	recorder = null;
	globalThis.WebSocket = OriginalWebSocket;
	FakeUpstreamWebSocket.reset();
	DatabaseFactory.reset();
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
	delete process.env.ccflare_DB_PATH;
	delete process.env.ccflare_CONFIG_PATH;
});

function insertCodexAccount(account: Account): void {
	DatabaseFactory.getInstance().createAccount({
		name: account.name,
		provider: account.provider,
		auth_method: account.auth_method,
		base_url: account.base_url,
		api_key: account.api_key,
		refresh_token: account.refresh_token,
		access_token: account.access_token,
		expires_at: account.expires_at,
		weight: account.weight,
	});
}

function createProxyContext(): ProxyContext {
	const dbOps = DatabaseFactory.getInstance();
	recorder = new WebSocketTranscriptRecorder(dbOps);
	return {
		providerRegistry: new ProviderRegistry([new CodexProvider()]),
		strategy: {
			select(selectedAccounts: Account[]) {
				return selectedAccounts;
			},
		},
		dbOps,
		runtime: {
			clientId: "test-client",
			retry: { attempts: 1, delayMs: 0, backoff: 1 },
			sessionDurationMs: 0,
			port: 8080,
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue() {} },
		usageWorker: { postMessage() {} },
		websocketRecorder: recorder,
	} as unknown as ProxyContext;
}

async function openTestConnection(): Promise<{
	ctx: ProxyContext;
	downstream: FakeServerWebSocket;
	capture: FakeUpstreamCapture;
}> {
	insertCodexAccount(createCodexAccount());
	const ctx = createProxyContext();
	const url = new URL("http://localhost:8080/v1/codex/responses");
	let upgradeOptions:
		| { headers?: HeadersInit; data?: WebSocketProxyData }
		| undefined;
	handleWebSocketUpgradeRequest(
		new Request(url, {
			method: "GET",
			headers: { connection: "Upgrade", upgrade: "websocket" },
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
	websocketProxyHandler.open?.(
		downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
	);
	const capture = await waitFor(
		() => FakeUpstreamWebSocket.captures[0] ?? null,
		(value): value is FakeUpstreamCapture => value !== null,
	);
	return { ctx, downstream, capture };
}

function allTranscriptEntries(
	ctx: ProxyContext,
	requestId: string,
): WebSocketTranscriptEntry[] {
	return ctx.dbOps
		.listWebSocketTranscriptChunks(requestId, 0, 10_000)
		.flatMap((chunk) => chunk.entries);
}

describe("WebSocket request logging integration", () => {
	it("persists one live connection row and its ordered bidirectional transcript", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "ccflare-websocket-transcript-"));
		process.env.ccflare_DB_PATH = join(tempDir, "ccflare.db");
		process.env.ccflare_CONFIG_PATH = join(tempDir, "ccflare.json");
		DatabaseFactory.initialize();
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;

		const events: RequestStreamEvent[] = [];
		const listener = (event: RequestStreamEvent) => events.push(event);
		requestEvents.on("event", listener);
		try {
			const { ctx, downstream, capture } = await openTestConnection();
			const pending = ctx.dbOps.getRecentRequests(10);
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({ method: "WS", success: null });

			const clientFrame =
				'{"type":"response.create","model":"gpt-4o","input":"hello"}';
			websocketProxyHandler.message(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
				clientFrame,
			);
			await waitFor(
				() => capture.sent.length,
				(length) => length === 1,
			);
			expect(decodeMessageData(capture.sent[0])).toBe(clientFrame);

			capture.socket.emitMessage(
				'{"type":"response.created","response":{"id":"resp_ws"}}',
			);
			capture.socket.emitMessage(
				'{"type":"response.future_event","value":"preserve me"}',
			);
			capture.socket.emitMessage(new Uint8Array([1, 2, 3, 4]));
			const interleavedClientFrame =
				'{"type":"response.processed","response_id":"resp_ws"}';
			websocketProxyHandler.message(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
				interleavedClientFrame,
			);
			capture.socket.emitMessage(
				'{"type":"response.completed","response":{"id":"resp_ws","model":"gpt-4o","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
			);
			capture.socket.emitMessage(
				'{"type":"response.completed","response":{"id":"resp_ws_2","model":"gpt-4o","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":6},"output_tokens_details":{"reasoning_tokens":1}}}}',
			);
			await Bun.sleep(25);
			websocketProxyHandler.close?.(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
				1000,
				"done",
			);

			const completed = await waitFor(
				() => ctx.dbOps.getRecentRequests(10)[0] ?? null,
				(request): request is Request => request?.success === true,
			);
			expect(ctx.dbOps.getRecentRequests(10)).toHaveLength(1);
			expect(completed).toMatchObject({
				model: "gpt-4o",
				inputTokens: 16,
				cacheReadInputTokens: 6,
				outputTokens: 6,
				reasoningTokens: 1,
				totalTokens: 28,
			});
			const entries = allTranscriptEntries(ctx, completed.id);
			expect(entries.map((entry) => entry.sequence)).toEqual(
				entries.map((_, index) => index + 1),
			);
			const binarySequence = entries.find(
				(entry) => entry.frameType === "binary",
			)?.sequence;
			const interleavedClientSequence = entries.find(
				(entry) => entry.data === interleavedClientFrame,
			)?.sequence;
			expect(binarySequence).toBeNumber();
			expect(interleavedClientSequence).toBeNumber();
			expect(binarySequence as number).toBeLessThan(
				interleavedClientSequence as number,
			);
			expect(entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						direction: "client_to_upstream",
						frameType: "text",
						data: clientFrame,
					}),
					expect.objectContaining({
						direction: "upstream_to_client",
						data: expect.stringContaining("response.future_event"),
					}),
					expect.objectContaining({
						direction: "upstream_to_client",
						frameType: "binary",
						encoding: "base64",
						data: Buffer.from([1, 2, 3, 4]).toString("base64"),
					}),
				]),
			);
			await waitFor(
				() =>
					events.some(
						(event) =>
							event.type === "summary" && event.payload.id === completed.id,
					),
				Boolean,
			);
		} finally {
			requestEvents.off("event", listener);
		}
	});

	it("stores a cumulative transcript larger than the HTTP stream payload cap", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "ccflare-websocket-transcript-"));
		process.env.ccflare_DB_PATH = join(tempDir, "ccflare.db");
		process.env.ccflare_CONFIG_PATH = join(tempDir, "ccflare.json");
		DatabaseFactory.initialize();
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;
		const { ctx, downstream, capture } = await openTestConnection();
		const payload = "x".repeat(10 * 1024);
		for (let index = 0; index < 220; index++) {
			capture.socket.emitMessage(
				JSON.stringify({ type: "response.delta", index, payload }),
			);
		}
		await Bun.sleep(100);
		websocketProxyHandler.close?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			1000,
			"done",
		);
		const completed = await waitFor(
			() => ctx.dbOps.getRecentRequests(1)[0] ?? null,
			(request): request is Request => request?.success === true,
			5_000,
		);
		const entries = allTranscriptEntries(ctx, completed.id).filter(
			(entry) => entry.direction === "upstream_to_client",
		);
		expect(entries).toHaveLength(220);
		expect(
			ctx.dbOps
				.listWebSocketTranscriptChunks(completed.id, 0, 10_000)
				.reduce((sum, chunk) => sum + chunk.byteLength, 0),
		).toBeGreaterThan(2 * 1024 * 1024);
	});
});
