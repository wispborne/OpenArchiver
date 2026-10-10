import { api } from '$lib/server/api';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { IngestionStats, MailboxMergeStatus, SafeIngestionSource } from '@open-archiver/types';

export const load: PageServerLoad = async (event) => {
	const { id } = event.params;

	const [statsResponse, sourceResponse, mergeStatusResponse] = await Promise.all([
		api(`/ingestion-sources/${id}/stats`, event),
		api(`/ingestion-sources/${id}`, event),
		api(`/ingestion-sources/${id}/mailboxes/merge-status`, event),
	]);

	if (!statsResponse.ok) {
		const responseText = await statsResponse.json().catch(() => ({}));
		return error(
			statsResponse.status,
			responseText.message || 'Failed to load ingestion statistics.'
		);
	}

	const stats: IngestionStats = await statsResponse.json();
	const source: SafeIngestionSource | null = sourceResponse.ok
		? await sourceResponse.json()
		: null;

	// Optional: the page works without it, it just cannot show merge progress.
	const mergeStatus: MailboxMergeStatus | null = mergeStatusResponse.ok
		? await mergeStatusResponse.json().catch(() => null)
		: null;

	return { stats, source, mergeStatus };
};
