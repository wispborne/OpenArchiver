import { Job } from 'bullmq';
import type { IAttachmentRepairResult } from '@open-archiver/types';
import { AttachmentRepairService } from '../../services/AttachmentRepairService';
import { logger } from '../../config/logger';

/**
 * Restores attachment files missing from storage; see AttachmentRepairService. The run is recorded
 * as it starts and as it ends, because the job's own record is soon trimmed from the queue.
 */
export default async function repairAttachmentsProcessor(
	job: Job
): Promise<IAttachmentRepairResult> {
	const startedAt = new Date().toISOString();
	await AttachmentRepairService.recordRun({
		state: 'running',
		result: null,
		error: null,
		startedAt,
		finishedAt: null,
	});
	try {
		logger.info('Starting attachment repair');
		const result = await AttachmentRepairService.run(job);
		logger.info({ ...result }, 'Finished attachment repair');
		await AttachmentRepairService.recordRun({
			state: 'completed',
			result,
			error: null,
			startedAt,
			finishedAt: new Date().toISOString(),
		});
		return result;
	} catch (error) {
		await AttachmentRepairService.recordRun({
			state: 'failed',
			result: null,
			error: error instanceof Error ? error.message : String(error),
			startedAt,
			finishedAt: new Date().toISOString(),
		});
		throw error;
	}
}
