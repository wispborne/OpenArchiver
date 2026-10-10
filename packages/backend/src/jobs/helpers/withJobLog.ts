import type { Job } from 'bullmq';
import { logger } from '../../config/logger';

/** Longest result written to a job's log; job results can be large objects. */
const MAX_RESULT_CHARS = 2000;

/**
 * Wraps a worker's processor so every job records when it started, how it ended and how long it
 * took in its own BullMQ log, which the Jobs page shows.
 *
 * Done once here rather than in each processor so that every job has at least these lines, upstream
 * processors included, without editing them. A processor can still add its own with `job.log()`.
 * Writing a log line never fails the job: a lost line is logged to the worker's output and dropped.
 */
export const withJobLog =
	<T>(processor: (job: Job) => Promise<T>) =>
	async (job: Job): Promise<T> => {
		const write = async (line: string) => {
			try {
				await job.log(line);
			} catch (error) {
				logger.warn({ err: error, jobId: job.id }, 'Could not write a job log line');
			}
		};
		const started = Date.now();
		const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
		const attempts = job.opts.attempts ?? 1;
		await write(
			attempts > 1 ? `Started (attempt ${job.attemptsMade + 1} of ${attempts}).` : 'Started.'
		);
		try {
			const result = await processor(job);
			let summary = '';
			if (result !== undefined) {
				const json = JSON.stringify(result);
				summary =
					json && json.length > MAX_RESULT_CHARS
						? ` Result: ${json.slice(0, MAX_RESULT_CHARS)}…`
						: ` Result: ${json}`;
			}
			await write(`Finished in ${seconds()}s.${summary}`);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await write(`Failed after ${seconds()}s: ${message}`);
			throw error;
		}
	};
