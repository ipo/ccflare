import { CodexProvider, ProviderRegistry } from "@ccflare/providers";
import type {
	IncomingWorkerMessage,
	ProxyContext,
	WebSocketProxyData,
} from "@ccflare/proxy";
import type { Account } from "@ccflare/types";

export type FakeUpstreamCapture = {
	url: string;
	headers: Record<string, string>;
	protocols: string[];
	socket: FakeUpstreamWebSocket;
	sent: Array<string | Uint8Array | ArrayBuffer>;
	closeEvents: Array<{ code: number; reason: string }>;
};

export const OriginalWebSocket = globalThis.WebSocket;

function normalizeHeaders(
	headers: Bun.WebSocketOptions["headers"] | undefined,
): Record<string, string> {
	if (!headers) {
		return {};
	}

	if (headers instanceof Headers) {
		return Object.fromEntries(
			Array.from(headers.entries(), ([key, value]) => [
				key.toLowerCase(),
				value,
			]),
		);
	}

	return Object.fromEntries(
		Object.entries(headers).flatMap(([key, value]) => {
			if (value === undefined) {
				return [];
			}

			return [
				[
					key.toLowerCase(),
					Array.isArray(value) ? value.join(", ") : String(value),
				],
			];
		}),
	);
}

function getProtocols(options: unknown): string[] {
	if (!options) {
		return [];
	}

	if (typeof options === "string") {
		return [options];
	}

	if (Array.isArray(options)) {
		return options.map(String);
	}

	if (typeof options !== "object") {
		return [];
	}

	const protocols = (options as { protocols?: unknown }).protocols;
	if (!protocols) {
		return [];
	}

	if (typeof protocols === "string") {
		return [protocols];
	}

	return Array.isArray(protocols) ? protocols.map(String) : [];
}

export function decodeMessageData(
	data: string | Uint8Array | ArrayBuffer,
): string {
	if (typeof data === "string") {
		return data;
	}

	return new TextDecoder().decode(
		data instanceof ArrayBuffer ? data : data.buffer,
	);
}

export function cloneMessageData(
	data: string | Buffer | ArrayBuffer | Uint8Array,
): string | Uint8Array | ArrayBuffer {
	if (typeof data === "string") {
		return data;
	}

	if (data instanceof ArrayBuffer) {
		return data.slice(0);
	}

	return new Uint8Array(data);
}

export async function waitFor<T>(
	getValue: () => Promise<T> | T,
	isReady: (value: T) => boolean,
	timeoutMs = 2_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastValue: T | null = null;

	while (Date.now() < deadline) {
		lastValue = await getValue();
		if (isReady(lastValue)) {
			return lastValue;
		}

		await Bun.sleep(25);
	}

	throw new Error(
		`Timed out waiting for expected state: ${JSON.stringify(lastValue)}`,
	);
}

export class FakeUpstreamWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	static captures: FakeUpstreamCapture[] = [];

	readonly url: string;
	readonly headers: Record<string, string>;
	readonly protocols: string[];
	readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
	readonly closeEvents: Array<{ code: number; reason: string }> = [];
	readyState = FakeUpstreamWebSocket.CONNECTING;
	binaryType: BinaryType = "blob";
	protocol = "";

	constructor(url: string | URL, options?: unknown) {
		super();
		this.url = String(url);
		this.headers = normalizeHeaders(
			typeof options === "object" && options
				? (options as Bun.WebSocketOptions).headers
				: undefined,
		);
		this.protocols = getProtocols(options);
		this.protocol = this.protocols[0] ?? "";

		FakeUpstreamWebSocket.captures.push({
			url: this.url,
			headers: this.headers,
			protocols: this.protocols,
			socket: this,
			sent: this.sent,
			closeEvents: this.closeEvents,
		});

		setTimeout(() => {
			if (this.readyState !== FakeUpstreamWebSocket.CONNECTING) {
				return;
			}

			this.readyState = FakeUpstreamWebSocket.OPEN;
			this.dispatchEvent(new Event("open"));
		}, 20);
	}

	send(data: string | Buffer | ArrayBuffer | Uint8Array): void {
		this.sent.push(cloneMessageData(data));
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === FakeUpstreamWebSocket.CLOSED) {
			return;
		}

		this.readyState = FakeUpstreamWebSocket.CLOSING;
		this.closeEvents.push({ code, reason });
		this.readyState = FakeUpstreamWebSocket.CLOSED;
		const closeEvent = new Event("close") as Event & {
			code: number;
			reason: string;
		};
		closeEvent.code = code;
		closeEvent.reason = reason;
		this.dispatchEvent(closeEvent);
	}

	emitMessage(data: string | Uint8Array | ArrayBuffer): void {
		const messageEvent = new Event("message") as Event & {
			data: string | Uint8Array | ArrayBuffer;
		};
		messageEvent.data = data;
		this.dispatchEvent(messageEvent);
	}

	static reset(): void {
		FakeUpstreamWebSocket.captures.length = 0;
	}
}

export class FakeServerWebSocket {
	readyState: number = WebSocket.OPEN;
	data: WebSocketProxyData;
	readonly sentTexts: string[] = [];
	readonly sentBinaries: BufferSource[] = [];
	readonly closeCalls: Array<{ code: number; reason: string }> = [];

	constructor(data: WebSocketProxyData) {
		this.data = data;
	}

	sendText(data: string): number {
		this.sentTexts.push(data);
		return 1;
	}

	sendBinary(data?: BufferSource): number {
		if (data !== undefined) {
			this.sentBinaries.push(data);
		}
		return 1;
	}

	close(code = 1000, reason = ""): void {
		this.readyState = WebSocket.CLOSED;
		this.closeCalls.push({ code, reason });
	}
}

export function createCodexAccount(name = "codex-oauth"): Account {
	return {
		id: "codex-account",
		name,
		provider: "codex",
		auth_method: "oauth",
		api_key: null,
		access_token: "codex-access-token",
		refresh_token: "codex-refresh-token",
		expires_at: Date.now() + 60_000,
		base_url: null,
		weight: 1,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
	};
}

export function createInMemoryProxyContext(
	accounts: Account[],
	usageMessages: IncomingWorkerMessage[] = [],
): ProxyContext {
	let transcriptSequence = 0;
	return {
		providerRegistry: new ProviderRegistry([new CodexProvider()]),
		strategy: {
			select(selectedAccounts: Account[]) {
				return selectedAccounts;
			},
		},
		dbOps: {
			getAllAccounts() {
				return accounts;
			},
			getAccountsByProvider(provider: Account["provider"]) {
				return accounts.filter((account) => account.provider === provider);
			},
			getAvailableAccountsByProvider(provider: Account["provider"]) {
				return accounts.filter(
					(account) =>
						account.provider === provider &&
						!account.paused &&
						(account.rate_limited_until === null ||
							account.rate_limited_until < Date.now()),
				);
			},
			saveRequestMeta() {},
			updateWebSocketClientSessionId() {},
			updateWebSocketRequestAccount() {},
			getRequestWithAccountName() {
				return null;
			},
		},
		runtime: {
			clientId: "test-client",
			retry: {
				attempts: 1,
				delayMs: 0,
				backoff: 1,
			},
			sessionDurationMs: 0,
			port: 8080,
		},
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue() {},
		},
		usageWorker: {
			postMessage(message: IncomingWorkerMessage) {
				usageMessages.push(message);
			},
		} as unknown as Worker,
		websocketRecorder: {
			start() {},
			reserveSequence() {
				transcriptSequence += 1;
				return transcriptSequence;
			},
			recordReservedFrame() {},
			prepareFinalize() {},
			discard() {},
			recordFrame() {},
			recordLifecycle() {},
			finalize() {
				return null;
			},
		},
	} as unknown as ProxyContext;
}
