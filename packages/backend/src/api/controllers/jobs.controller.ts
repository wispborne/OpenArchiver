import { Request, Response } from 'express';
import { JobActionError, JobsService } from '../../services/JobsService';
import { logger } from '../../config/logger';
import {
	IGetQueueJobsRequestParams,
	IGetQueueJobsRequestQuery,
	JobActionRefusal,
	JobStatus,
} from '@open-archiver/types';

/** HTTP status for each reason a job or queue action can be refused. */
const JOB_ACTION_STATUS: Record<JobActionRefusal, number> = {
	not_found: 404,
	wrong_state: 409,
	not_retryable: 409,
};

export class JobsController {
	private jobsService: JobsService;

	constructor() {
		this.jobsService = new JobsService();
	}

	public getQueues = async (req: Request, res: Response) => {
		try {
			const queues = await this.jobsService.getQueues();
			res.status(200).json({ queues });
		} catch (error) {
			res.status(500).json({ message: 'Error fetching queues', error });
		}
	};

	public getQueueJobs = async (req: Request, res: Response) => {
		try {
			const { queueName } = req.params as unknown as IGetQueueJobsRequestParams;
			const { status, page, limit } = req.query as unknown as IGetQueueJobsRequestQuery;
			const pageNumber = parseInt(page, 10) || 1;
			const limitNumber = parseInt(limit, 10) || 10;
			const queueDetails = await this.jobsService.getQueueDetails(
				queueName,
				status,
				pageNumber,
				limitNumber
			);
			res.status(200).json(queueDetails);
		} catch (error) {
			res.status(500).json({ message: 'Error fetching queue jobs', error });
		}
	};

	public getJob = async (req: Request, res: Response) => {
		try {
			const job = await this.jobsService.getJob(req.params.queueName, req.params.jobId);
			return res.status(200).json(job);
		} catch (error) {
			return this.actionError(req, res, error, 'Get job error');
		}
	};

	public retryJob = async (req: Request, res: Response) => {
		try {
			await this.jobsService.retryJob(req.params.queueName, req.params.jobId);
			return res.status(202).json({ message: req.t('jobs.retried') });
		} catch (error) {
			return this.actionError(req, res, error, 'Retry job error');
		}
	};

	public removeJob = async (req: Request, res: Response) => {
		try {
			await this.jobsService.removeJob(req.params.queueName, req.params.jobId);
			return res.status(200).json({ message: req.t('jobs.removed') });
		} catch (error) {
			return this.actionError(req, res, error, 'Remove job error');
		}
	};

	public retryAllFailed = async (req: Request, res: Response) => {
		try {
			await this.jobsService.retryAllFailed(req.params.queueName);
			return res.status(202).json({ message: req.t('jobs.retriedAll') });
		} catch (error) {
			return this.actionError(req, res, error, 'Retry all failed jobs error');
		}
	};

	public clean = async (req: Request, res: Response) => {
		const { state } = (req.body ?? {}) as { state?: unknown };
		if (state !== 'completed' && state !== 'failed') {
			return res.status(400).json({ message: req.t('jobs.invalidCleanState') });
		}
		try {
			const removed = await this.jobsService.clean(req.params.queueName, state);
			return res.status(200).json({ message: req.t('jobs.cleaned'), removed });
		} catch (error) {
			return this.actionError(req, res, error, 'Clean queue error');
		}
	};

	public pause = async (req: Request, res: Response) => {
		try {
			await this.jobsService.setPaused(req.params.queueName, true);
			return res.status(200).json({ message: req.t('jobs.paused') });
		} catch (error) {
			return this.actionError(req, res, error, 'Pause queue error');
		}
	};

	public resume = async (req: Request, res: Response) => {
		try {
			await this.jobsService.setPaused(req.params.queueName, false);
			return res.status(200).json({ message: req.t('jobs.resumed') });
		} catch (error) {
			return this.actionError(req, res, error, 'Resume queue error');
		}
	};

	private actionError(req: Request, res: Response, error: unknown, logMessage: string) {
		if (error instanceof JobActionError) {
			return res
				.status(JOB_ACTION_STATUS[error.reason])
				.json({ message: req.t(`jobs.${error.reason}`), reason: error.reason });
		}
		logger.error({ err: error, params: req.params }, logMessage);
		return res.status(500).json({ message: req.t('errors.internalServerError') });
	}
}
