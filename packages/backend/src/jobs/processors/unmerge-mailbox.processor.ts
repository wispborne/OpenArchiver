import { Job } from 'bullmq';
import type { IUnmergeMailboxJob } from '@open-archiver/types';
import { MailboxMergeService } from '../../services/MailboxMergeService';
import { logger } from '../../config/logger';
import { progressReporter } from './merge-mailboxes.processor';

/** Moves a previously merged mailbox's rows back out of the mailbox it was merged into. */
export default async function unmergeMailboxProcessor(
	job: Job<IUnmergeMailboxJob>
): Promise<{ moved: number }> {
	const { rootSourceId, mailbox } = job.data;
	const run = {
		kind: 'unmerge' as const,
		mailbox,
		into: null,
		collapseDuplicates: false,
		startedAt: new Date().toISOString(),
	};
	await MailboxMergeService.recordRun(rootSourceId, {
		...run,
		state: 'running',
		result: null,
		error: null,
		finishedAt: null,
	});

	try {
		logger.info({ rootSourceId, mailbox }, 'Starting mailbox unmerge');
		const moved = await MailboxMergeService.runUnmerge(job.data, progressReporter(job));
		logger.info({ rootSourceId, mailbox, moved }, 'Finished mailbox unmerge');

		await MailboxMergeService.recordRun(rootSourceId, {
			...run,
			state: 'completed',
			result: { moved, duplicatesRemoved: 0, duplicatesKept: 0 },
			error: null,
			finishedAt: new Date().toISOString(),
		});
		return { moved };
	} catch (error) {
		await MailboxMergeService.recordRun(rootSourceId, {
			...run,
			state: 'failed',
			result: null,
			error: error instanceof Error ? error.message : String(error),
			finishedAt: new Date().toISOString(),
		});
		throw error;
	}
}
