/**
 * Source names for source ids, so results can say "alice mbox" rather than only a UUID.
 *
 * Search hits carry only `ingestionSourceId`. Looking the names up on every search would double
 * the requests against the API's shared rate limit, so the list is cached per API key for a
 * minute. Per key, because two keys can see different sources; a key that may not list sources
 * (a role with archive access only) caches an empty map and gets `null` names.
 */
import type { SafeIngestionSource } from '@open-archiver/types';
import { ToolError, type ArchiveClient } from './client.js';

const TTL_MS = 60_000;

interface CacheEntry {
	expiresAt: number;
	sources: Map<string, SafeIngestionSource>;
}

const cache = new Map<string, CacheEntry>();

export async function listSources(
	client: ArchiveClient,
	cacheKey: string,
	{ fresh = false } = {}
): Promise<Map<string, SafeIngestionSource>> {
	const cached = cache.get(cacheKey);
	if (!fresh && cached && cached.expiresAt > Date.now()) {
		return cached.sources;
	}

	let sources = new Map<string, SafeIngestionSource>();
	try {
		const list = await client.get<SafeIngestionSource[]>(
			'/v1/ingestion-sources',
			{},
			{ permission: 'read ingestion sources (`read` on `ingestion`)' }
		);
		sources = new Map(list.map((source) => [source.id, source]));
	} catch (error) {
		// Names are a convenience everywhere except archive_list_sources itself, which passes
		// `fresh` and wants the real error.
		if (fresh || !(error instanceof ToolError)) throw error;
	}

	cache.set(cacheKey, { expiresAt: Date.now() + TTL_MS, sources });
	return sources;
}

export async function sourceNameLookup(
	client: ArchiveClient,
	cacheKey: string
): Promise<(id: string) => string | null> {
	const sources = await listSources(client, cacheKey);
	return (id) => sources.get(id)?.name ?? null;
}
