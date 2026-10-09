import { Job } from 'bullmq';
import type { IMergeMailboxesJob, IMergeMailboxesResult } from '@open-archiver/types';
import { MailboxMergeService } from '../../services/MailboxMergeService';
import { UserService } from '../../services/UserService';
import { logger } from '../../config/logger';

/**
 * Moves a merged mailbox's archived rows into the mailbox it was merged into.
 *
 * The alias was recorded when the merge was requested; this is the part too large for a request.
 * Dispatched with `attempts: 1`, like the other jobs that can delete: re-requesting the merge is
 * safe and finishes whatever a failed run left behind.
 */
export default async function mergeMailboxesProcessor(
	job: Job<IMergeMailboxesJob>
): Promise<IMergeMailboxesResult> {
	const { rootSourceId, from, into, actorId } = job.data;

	// Re-read rather than carried in the payload, so the audit entries a duplicate removal writes
	// name a user that still exists.
	const actor = await new UserService().findById(actorId);
	if (!actor) {
		throw new Error(
			`Cannot merge mailboxes: the user who requested it (${actorId}) no longer exists.`
		);
	}

	logger.info({ rootSourceId, from, into }, 'Starting mailbox merge');
	const result = await MailboxMergeService.runMerge(job.data, actor);
	logger.info({ rootSourceId, from, into, ...result }, 'Finished mailbox merge');
	return result;
}
