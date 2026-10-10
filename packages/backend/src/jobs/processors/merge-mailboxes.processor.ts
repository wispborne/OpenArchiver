import { Job } from 'bullmq';
import type {
	IMergeMailboxesJob,
	IMergeMailboxesResult,
	MailboxMergeProgress,
} from '@open-archiver/types';
import { MailboxMergeService } from '../../services/MailboxMergeService';
import { UserService } from '../../services/UserService';
import { logger } from '../../config/logger';

/**
 * Forwards a run's progress to BullMQ, where the status endpoint reads it.
 *
 * A failed write is logged and dropped: progress is for display, and losing one report must not
 * fail a job that is moving rows. Shared with the unmerge processor.
 */
export const progressReporter = (job: Job) => {
	let lastPhase: MailboxMergeProgress['phase'] | null = null;
	return async (progress: MailboxMergeProgress): Promise<void> => {
		try {
			await job.updateProgress({ ...progress, reportedAt: new Date().toISOString() });
			// One log line per phase, not per batch: the Jobs page shows the log, and a line per
			// few hundred rows would bury the phases in a long merge.
			if (progress.phase !== lastPhase) {
				lastPhase = progress.phase;
				await job.log(PHASE_LOG[progress.phase](progress));
			}
		} catch (error) {
			logger.warn({ err: error, jobId: job.id }, 'Could not report mailbox merge progress');
		}
	};
};

const PHASE_LOG: Record<MailboxMergeProgress['phase'], (p: MailboxMergeProgress) => string> = {
	moving: (p) => `Moving ${p.total} emails.`,
	settling: (p) =>
		`Moved ${p.moved}. Waiting until ${p.settleUntil} for running syncs to pick up the change.`,
	final_pass: (p) => `Final pass: ${p.total - p.moved} emails arrived during the wait.`,
	removing_duplicates: (p) => `Moved ${p.moved}. Removing duplicate copies.`,
};

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
	const { rootSourceId, from, into, actorId, collapseDuplicates } = job.data;
	const run = {
		kind: 'merge' as const,
		mailbox: from,
		into,
		collapseDuplicates,
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
		// Re-read rather than carried in the payload, so the audit entries a duplicate removal
		// writes name a user that still exists.
		const actor = await new UserService().findById(actorId);
		if (!actor) {
			throw new Error(
				`Cannot merge mailboxes: the user who requested it (${actorId}) no longer exists.`
			);
		}

		logger.info({ rootSourceId, from, into }, 'Starting mailbox merge');
		const result = await MailboxMergeService.runMerge(job.data, actor, progressReporter(job));
		logger.info({ rootSourceId, from, into, ...result }, 'Finished mailbox merge');

		await MailboxMergeService.recordRun(rootSourceId, {
			...run,
			state: 'completed',
			result,
			error: null,
			finishedAt: new Date().toISOString(),
		});
		return result;
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
