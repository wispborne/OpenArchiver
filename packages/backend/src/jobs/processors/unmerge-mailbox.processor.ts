import { Job } from 'bullmq';
import type { IUnmergeMailboxJob } from '@open-archiver/types';
import { MailboxMergeService } from '../../services/MailboxMergeService';
import { logger } from '../../config/logger';

/** Moves a previously merged mailbox's rows back out of the mailbox it was merged into. */
export default async function unmergeMailboxProcessor(
	job: Job<IUnmergeMailboxJob>
): Promise<{ moved: number }> {
	const { rootSourceId, mailbox } = job.data;
	logger.info({ rootSourceId, mailbox }, 'Starting mailbox unmerge');
	const moved = await MailboxMergeService.runUnmerge(job.data);
	logger.info({ rootSourceId, mailbox, moved }, 'Finished mailbox unmerge');
	return { moved };
}
