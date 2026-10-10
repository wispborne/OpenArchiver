import { Router } from 'express';
import { IngestionController } from '../controllers/ingestion.controller';
import { OAuthController } from '../controllers/oauth.controller';
import { requireAuth } from '../middleware/requireAuth';
import { requirePermission, ingestionResource } from '../middleware/requirePermission';
import { AuthService } from '../../services/AuthService';

export const createIngestionRouter = (
	ingestionController: IngestionController,
	authService: AuthService,
	oauthController: OAuthController = new OAuthController()
): Router => {
	const router = Router();

	// Secure all routes in this module
	router.use(requireAuth(authService));

	/**
	 * @openapi
	 * /v1/ingestion-sources:
	 *   post:
	 *     summary: Create an ingestion source
	 *     description: Creates a new ingestion source and validates the connection. Returns the created source without credentials. Requires `create:ingestion` permission.
	 *     operationId: createIngestionSource
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     requestBody:
	 *       required: true
	 *       content:
	 *         application/json:
	 *           schema:
	 *             $ref: '#/components/schemas/CreateIngestionSourceDto'
	 *     responses:
	 *       '201':
	 *         description: Ingestion source created successfully.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/SafeIngestionSource'
	 *       '400':
	 *         description: Invalid input or connection test failed.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ErrorMessage'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *   get:
	 *     summary: List ingestion sources
	 *     description: Returns all ingestion sources accessible to the authenticated user. Credentials are excluded from the response. Requires `read:ingestion` permission.
	 *     operationId: listIngestionSources
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     responses:
	 *       '200':
	 *         description: Array of ingestion sources.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: array
	 *               items:
	 *                 $ref: '#/components/schemas/SafeIngestionSource'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.post('/', requirePermission('create', 'ingestion'), ingestionController.create);

	router.get('/', requirePermission('read', 'ingestion'), ingestionController.findAll);

	/**
	 * @openapi
	 * /v1/ingestion-sources/reindex-all:
	 *   post:
	 *     summary: Reindex the entire archive
	 *     description: Enqueues a reindex of every ingestion source. Rebuilds search documents from existing archived emails without re-ingesting. Requires `manage:ingestion` permission.
	 *     operationId: reindexAllIngestionSources
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     requestBody:
	 *       required: false
	 *       content:
	 *         application/json:
	 *           schema:
	 *             type: object
	 *             properties:
	 *               mode:
	 *                 type: string
	 *                 enum: [missing, full]
	 *     responses:
	 *       '202':
	 *         description: Reindex job accepted and queued.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 */
	router.post(
		'/reindex-all',
		requirePermission('manage', 'ingestion'),
		ingestionController.reindexAll
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/duplicates:
	 *   get:
	 *     summary: Count duplicate emails across the archive
	 *     description: Counts extra copies of the same email, meaning rows of one mailbox that share a Message-ID with an earlier row. These appeared when two sync cycles ran over one mailbox at the same time. Covers every ingestion source. Requires `manage:ingestion` permission.
	 *     operationId: countAllDuplicateEmails
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     responses:
	 *       '200':
	 *         description: Duplicate counts.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               properties:
	 *                 duplicates:
	 *                   type: integer
	 *                   description: Extra copies a cleanup would remove. Protected copies and copies whose content differs from the one kept are excluded.
	 *                 groups:
	 *                   type: integer
	 *                   description: Distinct messages those copies belong to.
	 *                 protected:
	 *                   type: integer
	 *                   description: Extra copies a cleanup will leave in place because of a legal hold, a retention label, or journaling.
	 *                 contentDiffers:
	 *                   type: integer
	 *                   description: Extra copies a cleanup will leave in place because their stored content differs from the copy kept.
	 *                 deletionEnabled:
	 *                   type: boolean
	 *                   description: Whether deletion is enabled for this instance (ENABLE_DELETION). Without it a cleanup is refused.
	 *                 running:
	 *                   type: boolean
	 *                   description: Whether a duplicate cleanup of any scope is queued or running.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 */
	router.get(
		'/duplicates',
		requirePermission('manage', 'ingestion'),
		ingestionController.getDuplicateCount
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/duplicates/cleanup:
	 *   post:
	 *     summary: Remove duplicate emails across the archive
	 *     description: Removes extra copies of the same email in the background. One copy of every message is kept, a copy is removed only when its stored content is identical to the kept one, and copies under legal hold, a retention label, or journaling are never removed. Needs deletion enabled (ENABLE_DELETION). One cleanup runs at a time; a request made while one is running joins it. Covers every ingestion source. Requires `manage:ingestion` permission.
	 *     operationId: cleanupAllDuplicateEmails
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     responses:
	 *       '202':
	 *         description: Cleanup queued, or joined a cleanup already running.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               properties:
	 *                 message:
	 *                   type: string
	 *                 duplicatesFound:
	 *                   type: integer
	 *                 workerAlive:
	 *                   type: boolean
	 *                 alreadyRunning:
	 *                   type: boolean
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         description: Deletion is disabled for this instance, or the caller lacks permission.
	 */
	router.post(
		'/duplicates/cleanup',
		requirePermission('manage', 'ingestion'),
		ingestionController.cleanupDuplicates
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}:
	 *   get:
	 *     summary: Get an ingestion source
	 *     description: Returns a single ingestion source by ID. Credentials are excluded. Requires `read:ingestion` permission.
	 *     operationId: getIngestionSourceById
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '200':
	 *         description: Ingestion source details.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/SafeIngestionSource'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 *   put:
	 *     summary: Update an ingestion source
	 *     description: Updates configuration for an existing ingestion source. Requires `update:ingestion` permission.
	 *     operationId: updateIngestionSource
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     requestBody:
	 *       required: true
	 *       content:
	 *         application/json:
	 *           schema:
	 *             $ref: '#/components/schemas/UpdateIngestionSourceDto'
	 *     responses:
	 *       '200':
	 *         description: Updated ingestion source.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/SafeIngestionSource'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 *   delete:
	 *     summary: Delete an ingestion source
	 *     description: Permanently deletes an ingestion source. Deletion must be enabled in system settings. Requires `delete:ingestion` permission.
	 *     operationId: deleteIngestionSource
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '204':
	 *         description: Ingestion source deleted. No content returned.
	 *       '400':
	 *         description: Deletion disabled or constraint error.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ErrorMessage'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.get(
		'/:id',
		requirePermission('read', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.findById
	);

	router.put(
		'/:id',
		requirePermission('update', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.update
	);

	router.delete(
		'/:id',
		requirePermission('delete', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.delete
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/import:
	 *   post:
	 *     summary: Trigger initial import
	 *     description: Enqueues an initial import job for the ingestion source. This imports all historical emails. Requires `create:ingestion` permission.
	 *     operationId: triggerInitialImport
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '202':
	 *         description: Initial import job accepted and queued.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/MessageResponse'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.post(
		'/:id/import',
		// `sync`, not `create`: this re-runs the import for a source that already exists. An
		// unconditional `create ingestion` rule (held by the End user role) would otherwise match
		// every source and defeat the record check below.
		requirePermission('sync', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.triggerInitialImport
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/oauth/authorize:
	 *   post:
	 *     summary: Start OAuth mailbox authorization
	 *     description: Starts (or restarts) the OAuth authorization of an `oauth_mailbox` ingestion source. For the authorization code flow the response carries the URL to send the administrator's browser to; for the device code flow it carries the user code and verification URL to display, with the device code itself kept server-side. The same endpoint serves first-time authorization and the Re-authorize action after tokens expire or consent is revoked. Requires `update:ingestion` permission.
	 *     operationId: startOAuthMailboxAuthorization
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     requestBody:
	 *       required: false
	 *       content:
	 *         application/json:
	 *           schema:
	 *             type: object
	 *             properties:
	 *               flow:
	 *                 type: string
	 *                 enum: [auth_code, device_code]
	 *                 description: Overrides the flow stored on the source for this attempt.
	 *     responses:
	 *       '200':
	 *         description: Authorization started.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/OAuthAuthorizeResponse'
	 *       '400':
	 *         description: The source is not an OAuth mailbox source.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.post(
		'/:id/oauth/authorize',
		requirePermission('update', 'ingestion', { loadResource: ingestionResource }),
		oauthController.authorize
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/oauth/poll:
	 *   post:
	 *     summary: Poll a device-code authorization
	 *     description: Performs one poll step of an in-progress device-code authorization for an `oauth_mailbox` source. The browser calls this on the interval returned by the authorize endpoint until `pending` is false. On success the source moves to `auth_success` and its initial import starts. Requires `update:ingestion` permission.
	 *     operationId: pollOAuthMailboxAuthorization
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Current state of the authorization.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/OAuthPollResponse'
	 *       '400':
	 *         description: The source is not an OAuth mailbox source.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.post(
		'/:id/oauth/poll',
		requirePermission('update', 'ingestion', { loadResource: ingestionResource }),
		oauthController.poll
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/pause:
	 *   post:
	 *     summary: Pause an ingestion source
	 *     description: Sets the ingestion source status to `paused`, stopping continuous sync. Requires `update:ingestion` permission.
	 *     operationId: pauseIngestionSource
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '200':
	 *         description: Ingestion source paused. Returns the updated source.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/SafeIngestionSource'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.post(
		'/:id/pause',
		requirePermission('update', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.pause
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/sync:
	 *   post:
	 *     summary: Force sync
	 *     description: Triggers an out-of-schedule continuous sync for the ingestion source. If a sync of the source is still running, nothing new is started and `alreadyRunning` is true, because a second sync of the same mailbox would run beside the first. Requires `sync:ingestion` permission.
	 *     operationId: triggerForceSync
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '202':
	 *         description: Force sync job accepted and queued, or a sync was already running.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               properties:
	 *                 message:
	 *                   type: string
	 *                 alreadyRunning:
	 *                   type: boolean
	 *                   description: True when a sync of the source was still running, so nothing new was started.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.post(
		'/:id/sync',
		requirePermission('sync', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.triggerForceSync
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/reindex:
	 *   post:
	 *     summary: Reindex an ingestion source
	 *     description: Enqueues a reindex of the source (and its merge group). Rebuilds search documents from existing archived emails without re-ingesting or duplicating. Requires `sync:ingestion` permission.
	 *     operationId: reindexIngestionSource
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     requestBody:
	 *       required: false
	 *       content:
	 *         application/json:
	 *           schema:
	 *             type: object
	 *             properties:
	 *               mode:
	 *                 type: string
	 *                 enum: [missing, full]
	 *     responses:
	 *       '202':
	 *         description: Reindex job accepted and queued.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.post(
		'/:id/reindex',
		requirePermission('sync', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.reindex
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/index-health:
	 *   get:
	 *     summary: Get index health for a source
	 *     description: Returns the number of archived emails vs. indexed documents for the source (and its merge group). Requires `read:ingestion` permission.
	 *     operationId: getIngestionSourceIndexHealth
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Index health snapshot.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               properties:
	 *                 archivedCount:
	 *                   type: integer
	 *                 indexedCount:
	 *                   type: integer
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.get(
		'/:id/index-health',
		requirePermission('read', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.getIndexHealth
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/stats:
	 *   get:
	 *     summary: Get statistics for a source
	 *     description: Returns read-only statistics for the source (and its merge group) — email/mailbox/thread counts, storage usage, index coverage, attachment/compliance counts, per-mailbox breakdown, merge-group children, and recent activity. Requires `read:ingestion` permission.
	 *     operationId: getIngestionSourceStats
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Ingestion source statistics.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.get(
		'/:id/stats',
		requirePermission('read', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.getStats
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/unmerge:
	 *   post:
	 *     summary: Unmerge a child ingestion source
	 *     description: Detaches a child source from its merge group, making it a standalone root source. Requires `update:ingestion` permission.
	 *     operationId: unmergeIngestionSource
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Source unmerged. Returns the updated source.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/SafeIngestionSource'
	 *       '400':
	 *         description: Source is not merged into another source.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.post(
		'/:id/unmerge',
		requirePermission('update', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.unmerge
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/mailboxes/merge-preview:
	 *   get:
	 *     summary: Preview a mailbox merge
	 *     description: Reports what merging one mailbox of the source's merge group into another would do — emails to move, messages both mailboxes hold, whether the target already exists — and whether the merge can run now. Changes nothing. Requires `update:ingestion` permission.
	 *     operationId: previewMailboxMerge
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *       - name: from
	 *         in: query
	 *         required: true
	 *         description: The mailbox to merge away.
	 *         schema:
	 *           type: string
	 *       - name: into
	 *         in: query
	 *         required: true
	 *         description: The mailbox to merge into. It does not need to exist yet.
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Merge preview. `blockedReason` is null when the merge can run.
	 *       '400':
	 *         description: Missing or malformed mailbox address.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.get(
		'/:id/mailboxes/merge-preview',
		requirePermission('update', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.previewMailboxMerge
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/mailboxes/merge:
	 *   post:
	 *     summary: Merge one mailbox into another
	 *     description: Merges a mailbox of the source's merge group into another mailbox of the same group. Archived emails are moved in the background, and mail still synced from the merged mailbox is archived under the target from now on. Nothing in storage is moved. With `collapseDuplicates`, copies of a message both mailboxes held are reduced to one; that needs deletion enabled and `delete:ingestion` permission, and never removes a copy under legal hold, a retention label, or journaling. Requires `update:ingestion` permission.
	 *     operationId: mergeMailboxes
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     requestBody:
	 *       required: true
	 *       content:
	 *         application/json:
	 *           schema:
	 *             type: object
	 *             required: [from, into]
	 *             properties:
	 *               from:
	 *                 type: string
	 *               into:
	 *                 type: string
	 *               collapseDuplicates:
	 *                 type: boolean
	 *                 default: false
	 *     responses:
	 *       '202':
	 *         description: Merge queued.
	 *       '400':
	 *         description: Malformed address, or the mailbox would be merged into itself.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         description: Duplicate removal requested without deletion enabled or without permission to delete.
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '409':
	 *         description: The mailbox is already merged elsewhere, or a sync or another merge is running.
	 */
	router.post(
		'/:id/mailboxes/merge',
		requirePermission('update', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.mergeMailboxes
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/mailboxes/unmerge:
	 *   post:
	 *     summary: Unmerge a mailbox
	 *     description: Undoes a mailbox merge. The alias is removed and the emails that were moved are moved back in the background. Copies removed as duplicates during the merge are not restored by this, and later syncs do not bring them back. Requires `update:ingestion` permission.
	 *     operationId: unmergeMailbox
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     requestBody:
	 *       required: true
	 *       content:
	 *         application/json:
	 *           schema:
	 *             type: object
	 *             required: [mailbox]
	 *             properties:
	 *               mailbox:
	 *                 type: string
	 *                 description: The mailbox that was merged away.
	 *     responses:
	 *       '202':
	 *         description: Unmerge queued.
	 *       '400':
	 *         description: Malformed address.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         description: The source does not exist, or the mailbox is not merged.
	 *       '409':
	 *         description: A sync or a merge is running.
	 */
	router.post(
		'/:id/mailboxes/unmerge',
		requirePermission('update', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.unmergeMailbox
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/mailbox-aliases:
	 *   get:
	 *     summary: List merged mailboxes
	 *     description: Lists the mailboxes of the source's merge group that were merged into another mailbox. Requires `read:ingestion` permission.
	 *     operationId: listMailboxAliases
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Mailbox aliases, oldest first.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.get(
		'/:id/mailbox-aliases',
		requirePermission('read', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.listMailboxAliases
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/mailboxes/merge-status:
	 *   get:
	 *     summary: Get mailbox merge progress
	 *     description: Reports the latest mailbox merge or unmerge of the source's merge group. While one is queued or running, `progress` says how many emails have moved and which phase it is in. Once it has finished, `result` (or `error`) says how it ended; that outcome stays readable for 30 days or until the group's next merge. `state` is `interrupted` when the job stopped without finishing, such as when its worker was killed; requesting the same merge or unmerge again finishes it. Answers `null` when the group has no merge on record. Requires `read:ingestion` permission.
	 *     operationId: getMailboxMergeStatus
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: The latest merge or unmerge, or `null`.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               nullable: true
	 *               properties:
	 *                 kind:
	 *                   type: string
	 *                   enum: [merge, unmerge]
	 *                 state:
	 *                   type: string
	 *                   enum: [queued, running, completed, failed, interrupted]
	 *                 mailbox:
	 *                   type: string
	 *                   description: The mailbox merged away, or for an unmerge, the mailbox being restored.
	 *                 into:
	 *                   type: string
	 *                   nullable: true
	 *                 collapseDuplicates:
	 *                   type: boolean
	 *                 progress:
	 *                   type: object
	 *                   nullable: true
	 *                   properties:
	 *                     phase:
	 *                       type: string
	 *                       enum: [moving, settling, final_pass, removing_duplicates]
	 *                     moved:
	 *                       type: integer
	 *                     total:
	 *                       type: integer
	 *                       description: Emails there were to move. Syncs can add more while it runs.
	 *                     settleUntil:
	 *                       type: string
	 *                       format: date-time
	 *                       description: When the wait for running syncs ends. Only in the `settling` phase.
	 *                 result:
	 *                   type: object
	 *                   nullable: true
	 *                   properties:
	 *                     moved:
	 *                       type: integer
	 *                     duplicatesRemoved:
	 *                       type: integer
	 *                     duplicatesKept:
	 *                       type: integer
	 *                 error:
	 *                   type: string
	 *                   nullable: true
	 *                 queuedAt:
	 *                   type: string
	 *                   format: date-time
	 *                   nullable: true
	 *                 startedAt:
	 *                   type: string
	 *                   format: date-time
	 *                   nullable: true
	 *                 finishedAt:
	 *                   type: string
	 *                   format: date-time
	 *                   nullable: true
	 *                 workerAlive:
	 *                   type: boolean
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.get(
		'/:id/mailboxes/merge-status',
		requirePermission('read', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.getMailboxMergeStatus
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/duplicates:
	 *   get:
	 *     summary: Count duplicate emails in a source
	 *     description: Counts extra copies of the same email, meaning rows of one mailbox that share a Message-ID with an earlier row. These appeared when two sync cycles ran over one mailbox at the same time. For a source in a merge group, covers the whole group. Requires `read:ingestion` permission.
	 *     operationId: countDuplicateEmails
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Duplicate counts.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               properties:
	 *                 duplicates:
	 *                   type: integer
	 *                   description: Extra copies a cleanup would remove. Protected copies and copies whose content differs from the one kept are excluded.
	 *                 groups:
	 *                   type: integer
	 *                   description: Distinct messages those copies belong to.
	 *                 protected:
	 *                   type: integer
	 *                   description: Extra copies a cleanup will leave in place because of a legal hold, a retention label, or journaling.
	 *                 contentDiffers:
	 *                   type: integer
	 *                   description: Extra copies a cleanup will leave in place because their stored content differs from the copy kept.
	 *                 deletionEnabled:
	 *                   type: boolean
	 *                   description: Whether deletion is enabled for this instance (ENABLE_DELETION). Without it a cleanup is refused.
	 *                 running:
	 *                   type: boolean
	 *                   description: Whether a duplicate cleanup of any scope is queued or running.
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.get(
		'/:id/duplicates',
		requirePermission('read', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.getDuplicateCount
	);

	/**
	 * @openapi
	 * /v1/ingestion-sources/{id}/duplicates/cleanup:
	 *   post:
	 *     summary: Remove duplicate emails from a source
	 *     description: Removes extra copies of the same email in the background. One copy of every message is kept, a copy is removed only when its stored content is identical to the kept one, and copies under legal hold, a retention label, or journaling are never removed. Needs deletion enabled (ENABLE_DELETION). One cleanup runs at a time; a request made while one is running joins it. For a source in a merge group, covers the whole group. Requires `delete:ingestion` permission.
	 *     operationId: cleanupDuplicateEmails
	 *     tags:
	 *       - Ingestion
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '202':
	 *         description: Cleanup queued, or joined a cleanup already running.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               properties:
	 *                 message:
	 *                   type: string
	 *                 duplicatesFound:
	 *                   type: integer
	 *                 workerAlive:
	 *                   type: boolean
	 *                 alreadyRunning:
	 *                   type: boolean
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '403':
	 *         description: Deletion is disabled for this instance, or the caller lacks permission.
	 *       '409':
	 *         description: A mailbox merge or unmerge is running on this source (`reason` is `merge_running`).
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.post(
		'/:id/duplicates/cleanup',
		requirePermission('delete', 'ingestion', { loadResource: ingestionResource }),
		ingestionController.cleanupDuplicates
	);

	return router;
};
