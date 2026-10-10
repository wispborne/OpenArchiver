import { Job, Queue } from 'bullmq';
import { ingestionQueue, indexingQueue } from '../jobs/queues';
import {
	IJob,
	IJobDetail,
	IQueueCounts,
	IQueueDetails,
	IQueueOverview,
	JobActionRefusal,
	JobStatus,
} from '@open-archiver/types';
import { isWorkerAlive } from '../jobs/helpers/workerLiveness';
import { IngestionService } from './IngestionService';

/** Most recent log lines returned with a job's details. */
const MAX_LOG_LINES = 500;

/** A job or queue action the request may not perform; `reason` maps to a status code. */
export class JobActionError extends Error {
	constructor(
		public readonly reason: JobActionRefusal,
		message: string
	) {
		super(message);
	}
}

export class JobsService {
	private queues: Queue[];

	constructor() {
		this.queues = [ingestionQueue, indexingQueue];
	}

	public async getQueues(): Promise<IQueueOverview[]> {
		return Promise.all(
			this.queues.map(async (queue) => {
				const [counts, isPaused, workerAlive] = await Promise.all([
					this.getCounts(queue),
					queue.isPaused(),
					isWorkerAlive(queue),
				]);
				return { name: queue.name, counts, isPaused, workerAlive };
			})
		);
	}

	public async getQueueDetails(
		queueName: string,
		status: JobStatus,
		page: number,
		limit: number
	): Promise<IQueueDetails> {
		const queue = this.getQueue(queueName);

		const [counts, isPaused, workerAlive] = await Promise.all([
			this.getCounts(queue),
			queue.isPaused(),
			isWorkerAlive(queue),
		]);
		const start = (page - 1) * limit;
		const end = start + limit - 1;
		// Jobs added with a priority sit in BullMQ's `prioritized` set rather than `wait`. To the
		// person reading the list both are simply waiting, so the tab shows them together.
		const types = status === 'waiting' ? ['wait', 'prioritized'] : [status];
		const jobs = await queue.getJobs(types as never, start, end, true);
		const totalJobs = await queue.getJobCountByTypes(...(types as never[]));
		const formatted = await Promise.all(jobs.map((job) => this.formatJob(queue, job)));

		return {
			name: queue.name,
			counts,
			isPaused,
			workerAlive,
			jobs: await this.withSourceNames(formatted),
			pagination: {
				currentPage: page,
				totalPages: Math.ceil(totalJobs / limit),
				totalJobs,
				limit,
			},
		};
	}

	public async getJob(queueName: string, jobId: string): Promise<IJobDetail> {
		const queue = this.getQueue(queueName);
		const job = await queue.getJob(jobId);
		if (!job) {
			throw new JobActionError('not_found', `Job ${jobId} not found in ${queueName}`);
		}
		const [formatted] = await this.withSourceNames([await this.formatJob(queue, job)]);
		const { logs, count } = await queue.getJobLogs(jobId, -MAX_LOG_LINES, -1, true);
		return { ...formatted, queueName: queue.name, logs, logCount: count };
	}

	/** Runs a failed indexing job again. See `IJob.canRetry` for why ingestion jobs are excluded. */
	public async retryJob(queueName: string, jobId: string): Promise<void> {
		const queue = this.getQueue(queueName);
		const job = await this.requireJob(queue, jobId);
		if (queue !== indexingQueue) {
			throw new JobActionError(
				'not_retryable',
				'Ingestion jobs are retried with Force Sync.'
			);
		}
		if ((await job.getState()) !== 'failed') {
			throw new JobActionError('wrong_state', 'Only failed jobs can be retried.');
		}
		await job.retry('failed');
	}

	/** Retries every failed job of the indexing queue. */
	public async retryAllFailed(queueName: string): Promise<void> {
		const queue = this.getQueue(queueName);
		if (queue !== indexingQueue) {
			throw new JobActionError(
				'not_retryable',
				'Ingestion jobs are retried with Force Sync.'
			);
		}
		await queue.retryJobs({ state: 'failed' });
	}

	/**
	 * Removes a finished job's record.
	 *
	 * Only finished jobs, because removing one that has not run leaves its work silently undone:
	 * a waiting mailbox sync would leave its sync cycle open forever, and a waiting merge would
	 * leave the alias recorded with the rows never moved. A running job cannot be stopped at all;
	 * BullMQ has no way to interrupt a processor mid-run.
	 */
	public async removeJob(queueName: string, jobId: string): Promise<void> {
		const queue = this.getQueue(queueName);
		const job = await this.requireJob(queue, jobId);
		const state = await job.getState();
		if (state !== 'completed' && state !== 'failed') {
			throw new JobActionError('wrong_state', 'Only finished jobs can be removed.');
		}
		await job.remove();
	}

	/** Removes every completed or every failed job record of a queue. Returns how many went. */
	public async clean(queueName: string, state: 'completed' | 'failed'): Promise<number> {
		const queue = this.getQueue(queueName);
		const removed = await queue.clean(0, 0, state);
		return removed.length;
	}

	/**
	 * Pauses or resumes a whole queue, for every worker. Running jobs finish; nothing new starts
	 * until it is resumed. The flag lives in Redis, so it survives worker and server restarts.
	 */
	public async setPaused(queueName: string, paused: boolean): Promise<void> {
		const queue = this.getQueue(queueName);
		if (paused) {
			await queue.pause();
		} else {
			await queue.resume();
		}
	}

	private getQueue(queueName: string): Queue {
		const queue = this.queues.find((q) => q.name === queueName);
		if (!queue) {
			throw new JobActionError('not_found', `Queue ${queueName} not found`);
		}
		return queue;
	}

	private async requireJob(queue: Queue, jobId: string): Promise<Job> {
		const job = await queue.getJob(jobId);
		if (!job) {
			throw new JobActionError('not_found', `Job ${jobId} not found in ${queue.name}`);
		}
		return job;
	}

	private async getCounts(queue: Queue): Promise<IQueueCounts> {
		const counts = await queue.getJobCounts(
			'active',
			'completed',
			'failed',
			'delayed',
			'waiting',
			'paused',
			'prioritized'
		);
		return {
			active: counts.active || 0,
			completed: counts.completed || 0,
			failed: counts.failed || 0,
			delayed: counts.delayed || 0,
			waiting: counts.waiting || 0,
			paused: counts.paused || 0,
			prioritized: counts.prioritized || 0,
		};
	}

	/** Adds each job's source name, looked up once per page rather than once per job. */
	private async withSourceNames(jobs: IJob[]): Promise<IJob[]> {
		const ids = [...new Set(jobs.map((j) => j.ingestionSourceId).filter(Boolean))] as string[];
		if (ids.length === 0) {
			return jobs;
		}
		const names = await IngestionService.getSourceNames(ids).catch(
			() => ({}) as Record<string, string>
		);
		return jobs.map((job) => ({
			...job,
			ingestionSourceName: job.ingestionSourceId ? names[job.ingestionSourceId] : undefined,
		}));
	}

	private async formatJob(queue: Queue, job: Job): Promise<IJob> {
		const state = await job.getState();
		return {
			id: job.id,
			name: job.name,
			data: job.data,
			state: state,
			failedReason: job.failedReason,
			timestamp: job.timestamp,
			processedOn: job.processedOn,
			finishedOn: job.finishedOn,
			attemptsMade: job.attemptsMade,
			stacktrace: job.stacktrace,
			returnValue: job.returnvalue,
			// Mailbox merge jobs name their source `rootSourceId`, so without the fallback the
			// Jobs page showed them with no source at all.
			ingestionSourceId: job.data?.ingestionSourceId ?? job.data?.rootSourceId,
			error: state === 'failed' ? job.stacktrace : undefined,
			progress: job.progress as number | object,
			// BullMQ stores 0 when a job was added without `attempts`; it still runs once.
			attemptsAllowed: Math.max(1, job.opts.attempts ?? 1),
			canRetry: queue === indexingQueue && state === 'failed',
			canRemove: state === 'completed' || state === 'failed',
		};
	}
}
