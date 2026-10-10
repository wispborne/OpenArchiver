import { get } from 'svelte/store';
import type { IJob, MailboxMergeProgress } from '@open-archiver/types';
import { t } from '$lib/translations';

/**
 * Presentation helpers for the Jobs pages: readable names and one-line descriptions for BullMQ
 * jobs, whose raw names and payloads are written for the workers, not for people.
 */

/** A job name in words, or the raw name for a job this list doesn't know. */
export const jobLabel = (name: string): string => {
	const key = `app.jobs.names.${name}`;
	const label = get(t)(key);
	return label && label !== key ? label : name;
};

/** The one thing that tells two jobs of the same kind apart, such as the mailbox a sync is for. */
export const describeJob = (job: Pick<IJob, 'name' | 'data'>): string => {
	const $t = get(t);
	const data = job.data ?? {};
	switch (job.name) {
		case 'process-mailbox':
			return data.userEmail ?? '';
		case 'index-email-batch':
			return Array.isArray(data.emails)
				? $t('app.jobs.describe_emails', { count: data.emails.length } as any)
				: '';
		case 'reindex':
			return data.mode === 'full'
				? $t('app.jobs.describe_reindex_full')
				: $t('app.jobs.describe_reindex_missing');
		case 'merge-mailboxes':
			return `${data.from} → ${data.into}`;
		case 'unmerge-mailbox':
			return data.mailbox ?? '';
		case 'cleanup-duplicates':
			return data.ingestionSourceId ? '' : $t('app.jobs.describe_all_sources');
		default:
			return '';
	}
};

/**
 * A progress fraction from 0 to 100, or null when the job reports none.
 *
 * BullMQ progress is whatever a processor reported: a bare percentage, or an object of its own.
 * The mailbox merge reports `{ moved, total }`; anything else unrecognised shows no bar rather
 * than a wrong one.
 */
export const jobPercent = (progress: IJob['progress']): number | null => {
	if (typeof progress === 'number') {
		return progress > 0 ? Math.min(100, Math.round(progress)) : null;
	}
	if (progress && typeof progress === 'object') {
		// A merge counts `moved`, the attachment repair counts `done`; both of a `total`.
		const p = progress as Partial<MailboxMergeProgress> & { done?: number };
		const done = typeof p.moved === 'number' ? p.moved : p.done;
		if (typeof done === 'number' && typeof p.total === 'number' && p.total > 0) {
			return Math.min(100, Math.round((done / p.total) * 100));
		}
	}
	return null;
};

/** A duration like "4.2s", "3m 10s" or "2h 5m". */
export const formatDuration = (ms: number): string => {
	if (ms < 0) ms = 0;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
};

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "5 minutes ago", "yesterday" and so on, from an epoch-millisecond time. */
export const timeAgo = (ms: number, now = Date.now()): string => {
	const seconds = Math.round((ms - now) / 1000);
	const abs = Math.abs(seconds);
	if (abs < 60) return relative.format(seconds, 'second');
	if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
	if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
	return relative.format(Math.round(seconds / 86400), 'day');
};

/** How long a job ran, or has been running. Null before it starts. */
export const jobDuration = (job: Pick<IJob, 'processedOn' | 'finishedOn'>, now = Date.now()) =>
	job.processedOn ? formatDuration((job.finishedOn ?? now) - job.processedOn) : null;
