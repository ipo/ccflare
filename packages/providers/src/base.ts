import { sanitizeProxyHeaders } from "@ccflare/http";
import { type Account, CCFLARE_SESSION_ID_HEADER } from "@ccflare/types";
import type { Provider, RateLimitInfo } from "./types";

/**
 * Headers that are provider-neutral transport artifacts and should always be
 * removed before forwarding a request upstream.
 */
const TRANSPORT_HEADERS_TO_DELETE = [
	"host",
	"accept-encoding",
	"content-encoding",
	// ccflare-owned session signal: consumed by ccflare, never forwarded upstream
	CCFLARE_SESSION_ID_HEADER,
] as const;

/**
 * Remove provider-neutral transport headers from a Headers object.
 * Auth-specific headers (Authorization, x-api-key, anthropic-version, etc.)
 * are NOT touched here -- those belong to the concrete providers.
 */
export function deleteTransportHeaders(headers: Headers): void {
	for (const h of TRANSPORT_HEADERS_TO_DELETE) {
		headers.delete(h);
	}
}

export abstract class BaseProvider implements Provider {
	abstract name: string;
	abstract defaultBaseUrl: string;

	/**
	 * Build the target URL for the provider.
	 * Default: trim trailing slashes from the base URL and append path + query.
	 * Override only if a provider needs genuinely different URL construction.
	 */
	buildUrl(upstreamPath: string, query: string, account?: Account): string {
		const baseUrl = (account?.base_url ?? this.defaultBaseUrl).replace(
			/\/+$/,
			"",
		);
		return `${baseUrl}${upstreamPath}${query}`;
	}

	/**
	 * Prepare headers for the provider request.
	 * Default implementation: add Bearer auth from the account (if present)
	 * and remove provider-neutral transport headers.
	 * Subclasses should call super or use deleteTransportHeaders() to get the
	 * transport cleanup, then layer on auth-specific headers.
	 */
	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);
		if (account?.access_token) {
			newHeaders.set("Authorization", `Bearer ${account.access_token}`);
		}
		deleteTransportHeaders(newHeaders);
		return newHeaders;
	}

	/**
	 * Parse rate limit information from response
	 * Default implementation: Check unified headers first, then fall back to 429 status
	 *
	 * Note: The default implementation considers any unified status other than "allowed"
	 * to be a hard rate limit. Providers should override this method if they need to
	 * distinguish between soft warnings (e.g., "allowed_warning") and hard limits.
	 */
	parseRateLimit(response: Response): RateLimitInfo {
		// Check for unified rate limit headers (used by Anthropic and others)
		const statusHeader = response.headers.get(
			"anthropic-ratelimit-unified-status",
		);
		const resetHeader = response.headers.get(
			"anthropic-ratelimit-unified-reset",
		);

		if (statusHeader || resetHeader) {
			const resetTime = resetHeader ? Number(resetHeader) * 1000 : undefined; // Convert to ms
			return {
				isRateLimited: statusHeader !== "allowed",
				resetTime,
				statusHeader: statusHeader || undefined,
			};
		}

		// Fall back to traditional 429 check
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		// Try to extract reset time from headers
		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;

		if (retryAfter) {
			// Retry-After can be seconds or HTTP date
			const seconds = Number(retryAfter);
			if (!Number.isNaN(seconds)) {
				resetTime = Date.now() + seconds * 1000;
			} else {
				resetTime = new Date(retryAfter).getTime();
			}
		}

		return { isRateLimited: true, resetTime };
	}

	/**
	 * Process the response before returning to client.
	 * Default implementation: sanitize hop-by-hop proxy headers.
	 * Override only if a provider needs custom response transformation.
	 */
	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		const headers = sanitizeProxyHeaders(response.headers);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	/**
	 * Extract usage information from response if available
	 * Default implementation: Return null (no usage info)
	 */
	async extractUsageInfo?(_response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
	} | null> {
		return null;
	}

	/**
	 * Check if the response is a streaming response
	 * Default implementation: Check for text/event-stream or stream in content-type
	 */
	isStreamingResponse?(response: Response): boolean {
		const contentType = response.headers.get("content-type") ?? "";
		return (
			contentType.includes("text/event-stream") ||
			contentType.includes("stream")
		);
	}
}
