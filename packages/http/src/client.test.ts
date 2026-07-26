import { afterEach, describe, expect, it, mock } from "bun:test";
import { HttpError } from "@ccflare/http";
import { HttpClient } from "./client";

class TestHttpClient extends HttpClient {
	getJsonPublic<T = unknown>(url: string) {
		return this.getJson<T>(url);
	}

	getTextPublic(url: string) {
		return this.getText(url);
	}
}

const originalFetch = globalThis.fetch;
type HttpClientWithOptions = { options: { retryDelay: number } };

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("HttpClient", () => {
	it("parses JSON responses through the JSON helper", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ ok: true }), {
					headers: {
						"Content-Type": "application/json",
					},
				}),
			),
		) as unknown as typeof fetch;

		const client = new TestHttpClient();
		await expect(
			client.getJsonPublic<{ ok: boolean }>("/api/test"),
		).resolves.toEqual({ ok: true });
	});

	it("returns plain text through the text helper", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response("hello", {
					headers: {
						"Content-Type": "text/plain",
					},
				}),
			),
		) as unknown as typeof fetch;

		const client = new TestHttpClient();
		await expect(client.getTextPublic("/api/test")).resolves.toBe("hello");
	});

	it("rejects non-JSON responses through the JSON helper", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response("not json", {
					headers: {
						"Content-Type": "text/plain",
					},
				}),
			),
		) as unknown as typeof fetch;

		const client = new TestHttpClient();
		await expect(client.getJsonPublic("/api/test")).rejects.toBeInstanceOf(
			HttpError,
		);
	});

	it("preserves an explicit zero retry delay", () => {
		const client = new TestHttpClient({ retryDelay: 0 });
		expect(
			(client as unknown as HttpClientWithOptions).options.retryDelay,
		).toBe(0);
	});
});
