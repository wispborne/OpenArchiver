import { Router } from 'express';
import { JobsController } from '../controllers/jobs.controller';
import { requireAuth } from '../middleware/requireAuth';
import { requirePermission } from '../middleware/requirePermission';
import { AuthService } from '../../services/AuthService';

export const createJobsRouter = (authService: AuthService): Router => {
	const router = Router();
	const jobsController = new JobsController();

	router.use(requireAuth(authService));

	/**
	 * @openapi
	 * /v1/jobs/queues:
	 *   get:
	 *     summary: List all queues
	 *     description: Returns all BullMQ job queues and their current job counts broken down by status. Requires `manage:all` (Super Admin) permission.
	 *     operationId: getQueues
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     responses:
	 *       '200':
	 *         description: List of queue overviews.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               properties:
	 *                 queues:
	 *                   type: array
	 *                   items:
	 *                     $ref: '#/components/schemas/QueueOverview'
	 *               example:
	 *                 queues:
	 *                   - name: ingestion
	 *                     counts:
	 *                       active: 0
	 *                       completed: 56
	 *                       failed: 4
	 *                       delayed: 3
	 *                       waiting: 0
	 *                       paused: 0
	 *                   - name: indexing
	 *                     counts:
	 *                       active: 0
	 *                       completed: 0
	 *                       failed: 0
	 *                       delayed: 0
	 *                       waiting: 0
	 *                       paused: 0
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.get(
		'/queues',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.getQueues
	);

	/**
	 * @openapi
	 * /v1/jobs/queues/{queueName}:
	 *   get:
	 *     summary: Get jobs in a queue
	 *     description: Returns a paginated list of jobs within a specific queue, filtered by status. Requires `manage:all` (Super Admin) permission.
	 *     operationId: getQueueJobs
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: queueName
	 *         in: path
	 *         required: true
	 *         description: The name of the queue (e.g. `ingestion` or `indexing`).
	 *         schema:
	 *           type: string
	 *           example: ingestion
	 *       - name: status
	 *         in: query
	 *         required: false
	 *         description: Filter jobs by status.
	 *         schema:
	 *           type: string
	 *           enum: [active, completed, failed, delayed, waiting, paused]
	 *           default: failed
	 *       - name: page
	 *         in: query
	 *         required: false
	 *         schema:
	 *           type: integer
	 *           default: 1
	 *       - name: limit
	 *         in: query
	 *         required: false
	 *         schema:
	 *           type: integer
	 *           default: 10
	 *     responses:
	 *       '200':
	 *         description: Detailed view of the queue including paginated jobs.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/QueueDetails'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 *       '404':
	 *         description: Queue not found.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ErrorMessage'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.get(
		'/queues/:queueName',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.getQueueJobs
	);

	/**
	 * @openapi
	 * /v1/jobs/queues/{queueName}/jobs/{jobId}:
	 *   get:
	 *     summary: Get a job
	 *     description: Returns one job with its payload, progress, result, error and stack trace, and the lines it logged (the most recent 500). Requires `manage:all` (Super Admin) permission.
	 *     operationId: getJob
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: queueName
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           enum: [ingestion, indexing]
	 *       - name: jobId
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: The job, with `queueName`, `logs` (strings, oldest first) and `logCount`.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/Job'
	 *       '404':
	 *         description: No such queue or job.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 */
	router.get(
		'/queues/:queueName/jobs/:jobId',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.getJob
	);

	/**
	 * @openapi
	 * /v1/jobs/queues/{queueName}/jobs/{jobId}:
	 *   delete:
	 *     summary: Remove a finished job
	 *     description: Deletes the record of a completed or failed job. Jobs that are waiting, delayed or running cannot be removed. Requires `manage:all` (Super Admin) permission.
	 *     operationId: removeJob
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: queueName
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           enum: [ingestion, indexing]
	 *       - name: jobId
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Removed.
	 *       '404':
	 *         description: No such queue or job.
	 *       '409':
	 *         description: The job has not finished (`reason` is `wrong_state`).
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 */
	router.delete(
		'/queues/:queueName/jobs/:jobId',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.removeJob
	);

	/**
	 * @openapi
	 * /v1/jobs/queues/{queueName}/jobs/{jobId}/retry:
	 *   post:
	 *     summary: Retry a failed job
	 *     description: Queues a failed job of the indexing queue to run again. Ingestion jobs are refused, because each belongs to a sync cycle; repeat a failed sync with Force Sync on the ingestion source. Requires `manage:all` (Super Admin) permission.
	 *     operationId: retryJob
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: queueName
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           enum: [ingestion, indexing]
	 *       - name: jobId
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '202':
	 *         description: Queued to run again.
	 *       '404':
	 *         description: No such queue or job.
	 *       '409':
	 *         description: The job has not failed (`reason` is `wrong_state`), or belongs to the ingestion queue (`not_retryable`).
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 */
	router.post(
		'/queues/:queueName/jobs/:jobId/retry',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.retryJob
	);

	/**
	 * @openapi
	 * /v1/jobs/queues/{queueName}/retry-failed:
	 *   post:
	 *     summary: Retry all failed jobs
	 *     description: Queues every failed job of the indexing queue to run again. Refused for the ingestion queue, for the reason given under "Retry a failed job". Requires `manage:all` (Super Admin) permission.
	 *     operationId: retryAllFailedJobs
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: queueName
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           enum: [ingestion, indexing]
	 *     responses:
	 *       '202':
	 *         description: Queued to run again.
	 *       '404':
	 *         description: No such queue or job.
	 *       '409':
	 *         description: The ingestion queue (`reason` is `not_retryable`).
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 */
	router.post(
		'/queues/:queueName/retry-failed',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.retryAllFailed
	);

	/**
	 * @openapi
	 * /v1/jobs/queues/{queueName}/clean:
	 *   post:
	 *     summary: Remove finished jobs
	 *     description: Deletes every completed, or every failed, job record of the queue. Requires `manage:all` (Super Admin) permission.
	 *     operationId: cleanQueue
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: queueName
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           enum: [ingestion, indexing]
	 *     requestBody:
	 *       required: true
	 *       content:
	 *         application/json:
	 *           schema:
	 *             type: object
	 *             required: [state]
	 *             properties:
	 *               state:
	 *                 type: string
	 *                 enum: [completed, failed]
	 *     responses:
	 *       '200':
	 *         description: How many job records were removed.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               properties:
	 *                 message:
	 *                   type: string
	 *                 removed:
	 *                   type: integer
	 *       '400':
	 *         description: Missing or invalid `state`.
	 *       '404':
	 *         description: No such queue or job.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 */
	router.post(
		'/queues/:queueName/clean',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.clean
	);

	/**
	 * @openapi
	 * /v1/jobs/queues/{queueName}/pause:
	 *   post:
	 *     summary: Pause a queue
	 *     description: Pauses the queue for every worker. Running jobs finish; no new job starts until the queue is resumed. The pause is stored in Redis and survives restarts. Requires `manage:all` (Super Admin) permission.
	 *     operationId: pauseQueue
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: queueName
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           enum: [ingestion, indexing]
	 *     responses:
	 *       '200':
	 *         description: Paused.
	 *       '404':
	 *         description: No such queue or job.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 */
	router.post(
		'/queues/:queueName/pause',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.pause
	);

	/**
	 * @openapi
	 * /v1/jobs/queues/{queueName}/resume:
	 *   post:
	 *     summary: Resume a queue
	 *     description: Resumes a paused queue. Requires `manage:all` (Super Admin) permission.
	 *     operationId: resumeQueue
	 *     tags:
	 *       - Jobs
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: queueName
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           enum: [ingestion, indexing]
	 *     responses:
	 *       '200':
	 *         description: Resumed.
	 *       '404':
	 *         description: No such queue or job.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         $ref: '#/components/responses/Forbidden'
	 */
	router.post(
		'/queues/:queueName/resume',
		requirePermission('manage', 'all', 'user.requiresSuperAdminRole'),
		jobsController.resume
	);

	return router;
};
