/**
 * HTTP client for the Open Archiver REST API.
 *
 * The MCP server never touches Postgres or Meilisearch: every read goes through the API with the
 * caller's API key, so permissions, IAM conditions (a role limited to one mailbox, say) and the
 * audit log apply exactly as they do for any other API client.
 */

/**
 * A failure the model should read and act on. Its message is written by this server (or is the
 * API's own translated message) and never contains text taken from an archived email, so an
 * email can't use an error message to smuggle in instructions.
 */
export class ToolError extends Error {}

export interface ClientOptions {
	/** The app's base URL, as opened in a browser, e.g. `http://localhost:3000`. */
	baseUrl: string;
	apiKey: string;
	/**
	 * The MCP client's IP, forwarded so the API's per-IP rate limit counts each client
	 * separately instead of lumping everyone behind the MCP server into one bucket.
	 */
	forwardedFor?: string;
}

export type QueryValue = string | number | boolean | string[] | undefined;

export interface RequestContext {
	/**
	 * What the call needs, in words, for the 403 message: e.g. "read ingestion sources
	 * (`read` on `ingestion`)".
	 */
	permission: string;
}

export class ArchiveClient {
	readonly #apiRoot: string;
	readonly #apiKey: string;
	readonly #forwardedFor?: string;

	constructor(options: ClientOptions) {
		// The app serves the API under `/api` (the SvelteKit proxy in front of the backend),
		// which is the one address users know; the backend's own port isn't published.
		this.#apiRoot = `${options.baseUrl.replace(/\/+$/, '')}/api`;
		this.#apiKey = options.apiKey;
		this.#forwardedFor = options.forwardedFor;
	}

	async get<T>(
		path: string,
		query: Record<string, QueryValue>,
		context: RequestContext
	): Promise<T> {
		const url = new URL(`${this.#apiRoot}${path}`);
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined) continue;
			if (Array.isArray(value)) {
				// The API takes list filters comma-separated.
				if (value.length > 0) url.searchParams.set(key, value.join(','));
			} else {
				url.searchParams.set(key, String(value));
			}
		}

		const headers: Record<string, string> = {
			'X-API-KEY': this.#apiKey,
			Accept: 'application/json',
		};
		if (this.#forwardedFor) {
			headers['X-Forwarded-For'] = this.#forwardedFor;
		}

		let response: Response;
		try {
			response = await fetch(url, { headers });
		} catch (error) {
			const reason = error instanceof Error ? (error.cause ?? error.message) : error;
			throw new ToolError(
				`Could not reach Open Archiver at ${this.#apiRoot} (${String(reason)}). ` +
					'Check OPEN_ARCHIVER_URL and that the server is running.'
			);
		}

		if (response.ok) {
			return (await response.json()) as T;
		}
		throw await this.#toToolError(response, context);
	}

	async #toToolError(response: Response, context: RequestContext): Promise<ToolError> {
		let apiMessage = '';
		try {
			const body = (await response.json()) as { message?: unknown };
			if (typeof body.message === 'string') apiMessage = body.message;
		} catch {
			// Not JSON (a proxy error page, say); the status alone has to do.
		}

		switch (response.status) {
			case 400:
				return new ToolError(
					`Open Archiver rejected the request: ${apiMessage || 'invalid parameters'}. ` +
						'Fix the named parameter and try again.'
				);
			case 401:
				return new ToolError(
					'Open Archiver rejected the API key (invalid, expired or revoked). ' +
						'Create a new key under Settings → API Keys and update the MCP server configuration.'
				);
			case 403:
				// The API's own refusals are JSON with a message. A 403 without one comes from
				// something in front of it (a reverse proxy, a dev server checking the Host
				// header), and calling that a missing permission would send the user to the
				// wrong place.
				if (!apiMessage) {
					return new ToolError(
						`Something in front of Open Archiver at ${this.#apiRoot} refused the request (HTTP 403, not from Open Archiver itself). ` +
							'Check OPEN_ARCHIVER_URL and any reverse proxy between this server and Open Archiver.'
					);
				}
				return new ToolError(
					`The API key's role lacks permission to ${context.permission}. ` +
						'Grant it to the role in Open Archiver, or use a key whose role has it.'
				);
			case 404:
				return new ToolError(
					'Not found, or not visible to this API key. ' +
						'Use an id taken from an archive_search or archive_list_sources result.'
				);
			case 429: {
				const retry =
					response.headers.get('retry-after') ?? response.headers.get('ratelimit-reset');
				const limit = response.headers.get('ratelimit-limit');
				return new ToolError(
					'Open Archiver is rate limiting requests' +
						(limit ? ` (${limit} per window, shared by every tool call)` : '') +
						'. ' +
						(retry ? `Retry in ${retry} seconds.` : 'Wait a minute before retrying.') +
						' Fetch fewer messages per call meanwhile.'
				);
			}
			default:
				return new ToolError(
					`Open Archiver returned an error (HTTP ${response.status})` +
						(apiMessage ? `: ${apiMessage}` : '') +
						'.'
				);
		}
	}
}
