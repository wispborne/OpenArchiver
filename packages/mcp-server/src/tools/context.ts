import type { ArchiveClient } from '../client.js';

/** What every tool needs for one connection (stdio) or one HTTP request. */
export interface ToolContext {
	client: ArchiveClient;
	/** Identifies the API key for per-key caches, without keeping the key itself around twice. */
	cacheKey: string;
}
