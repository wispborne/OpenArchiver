import { get } from 'svelte/store';
import type { IReindexResponse, ReindexMode } from '@open-archiver/types';
import { api } from '$lib/api.client';
import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
import { t } from '$lib/translations';

/**
 * Ingestion-source actions shared by the sources list and a source's own page, so both report
 * the outcome the same way. Each one shows its own alert.
 */

/**
 * Asks for an immediate sync. Returns whether a new sync was started: false when the request failed
 * and also when a sync was still running, which the server leaves alone rather than run a second
 * one beside it.
 */
export const forceSync = async (id: string): Promise<boolean> => {
	const $t = get(t);
	try {
		const res = await api(`/ingestion-sources/${id}/sync`, { method: 'POST' });
		const body = await res.json().catch(() => ({}));
		if (res.ok && body.alreadyRunning) {
			setAlert({
				type: 'warning',
				title: $t('app.ingestions.force_sync_already_running'),
				message: body.message ?? '',
				duration: 10000,
				show: true,
			});
			return false;
		}
		if (!res.ok) {
			setAlert({
				type: 'error',
				title: $t('app.ingestions.force_sync_failed'),
				message: body.message || `HTTP ${res.status}`,
				duration: 5000,
				show: true,
			});
			return false;
		}
		return true;
	} catch (error) {
		setAlert({
			type: 'error',
			title: $t('app.ingestions.force_sync_failed'),
			message: error instanceof Error ? error.message : String(error),
			duration: 5000,
			show: true,
		});
		return false;
	}
};

/**
 * Reports what a reindex actually achieved rather than that the request was accepted.
 *
 * A 202 only means the job reached the queue. It says nothing about whether an indexing worker
 * exists to run it, or whether there was anything to do — and both of those have silently been
 * false in practice, leaving a success message on screen while nothing happened.
 *
 * @returns whether anything was queued.
 */
export const runReindex = async (
	path: string,
	mode: ReindexMode,
	scope: 'source' | 'all'
): Promise<boolean> => {
	const $t = get(t);
	let body: Partial<IReindexResponse>;

	try {
		const res = await api(path, { method: 'POST', body: JSON.stringify({ mode }) });
		// Not res.json() straight into a variable: a proxy answering with an HTML 502 body makes
		// this reject, and an unhandled rejection inside a menu onclick closes the menu with no
		// alert at all — the user sees a click that did nothing.
		body = await res.json().catch(() => ({}));

		if (!res.ok) {
			setAlert({
				type: 'error',
				title: $t('app.ingestions.reindex_failed'),
				message: (body as { message?: string }).message ?? `HTTP ${res.status}`,
				duration: 5000,
				show: true,
			});
			return false;
		}
	} catch (error) {
		setAlert({
			type: 'error',
			title: $t('app.ingestions.reindex_failed'),
			message: error instanceof Error ? error.message : String(error),
			duration: 5000,
			show: true,
		});
		return false;
	}

	const count = body.pending ?? 0;

	if (body.pending === 0) {
		setAlert({
			type: 'warning',
			title: $t('app.ingestions.reindex_nothing_title'),
			message: $t(
				scope === 'all'
					? 'app.ingestions.reindex_nothing_all'
					: mode === 'full'
						? 'app.ingestions.reindex_nothing_full'
						: 'app.ingestions.reindex_nothing'
			),
			duration: 8000,
			show: true,
		});
		return false;
	}

	// A warning, not an error, and reported after the count: the job IS durably queued — the
	// enqueue happens before the liveness check — so telling the user it failed would be wrong and
	// would invite a repeat click that stacks another full rebuild.
	if (body.workerAlive === false) {
		setAlert({
			type: 'warning',
			title: $t('app.ingestions.reindex_no_worker_title'),
			message: $t('app.ingestions.reindex_no_worker', { count } as any),
			duration: 10000,
			show: true,
		});
		return true;
	}

	setAlert({
		type: 'success',
		title: $t('app.ingestions.reindex_success'),
		message: $t('app.ingestions.reindex_queued', { count } as any),
		duration: 5000,
		show: true,
	});
	return true;
};

/**
 * A link to the search page with advanced-search filters already applied. The search page reads
 * these from the URL and shows them in its filter panel, so the user can see and change them.
 */
export const searchUrl = (filters: {
	from?: string;
	to?: string;
	mailboxes?: string;
	sources?: string;
}): string => {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(filters)) {
		if (value) query.set(key, value);
	}
	return `/dashboard/search?${query}`;
};
