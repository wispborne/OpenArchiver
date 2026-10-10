import { Router } from 'express';
import { ArchivedEmailController } from '../controllers/archived-email.controller';
import { requireAuth } from '../middleware/requireAuth';
import { requirePermission, archivedEmailResource } from '../middleware/requirePermission';
import { AuthService } from '../../services/AuthService';

export const createArchivedEmailRouter = (
	archivedEmailController: ArchivedEmailController,
	authService: AuthService
): Router => {
	const router = Router();

	// Secure all routes in this module
	router.use(requireAuth(authService));

	/**
	 * @openapi
	 * /v1/archived-emails/ingestion-source/{ingestionSourceId}:
	 *   get:
	 *     summary: List archived emails for an ingestion source
	 *     description: Returns a paginated list of archived emails belonging to the specified ingestion source. Requires `read:archive` permission.
	 *     operationId: getArchivedEmails
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: ingestionSourceId
	 *         in: path
	 *         required: true
	 *         description: The ID of the ingestion source to retrieve emails for.
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *       - name: page
	 *         in: query
	 *         required: false
	 *         description: Page number for pagination.
	 *         schema:
	 *           type: integer
	 *           default: 1
	 *           example: 1
	 *       - name: limit
	 *         in: query
	 *         required: false
	 *         description: Number of items per page.
	 *         schema:
	 *           type: integer
	 *           default: 10
	 *           example: 10
	 *     responses:
	 *       '200':
	 *         description: Paginated list of archived emails.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/PaginatedArchivedEmails'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.get(
		'/ingestion-source/:ingestionSourceId',
		requirePermission('read', 'archive'),
		archivedEmailController.getArchivedEmails
	);

	/**
	 * @openapi
	 * /v1/archived-emails/{id}:
	 *   get:
	 *     summary: Get a single archived email
	 *     description: Retrieves the full details of a single archived email by ID, including attachments and thread. Requires `read:archive` permission.
	 *     operationId: getArchivedEmailById
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         description: The ID of the archived email.
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '200':
	 *         description: Archived email details.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ArchivedEmail'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 *   delete:
	 *     summary: Delete an archived email
	 *     description: Permanently deletes an archived email by ID. Deletion must be enabled in system settings and the email must not be on legal hold. Requires `delete:archive` permission.
	 *     operationId: deleteArchivedEmail
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         description: The ID of the archived email to delete.
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '204':
	 *         description: Email deleted successfully. No content returned.
	 *       '400':
	 *         description: Deletion is disabled in system settings, or the email is blocked by a retention policy / legal hold.
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
		requirePermission('read', 'archive'),
		archivedEmailController.getArchivedEmailById
	);

	/**
	 * @openapi
	 * /v1/archived-emails/{id}/content:
	 *   get:
	 *     summary: Get an archived email's parsed content
	 *     description: >-
	 *       Returns the email parsed on the server, with readable text instead of the raw .eml bytes
	 *       that `GET /v1/archived-emails/{id}` returns. Meant for API clients such as the MCP server.
	 *       Applies the same permission check and writes the same READ audit entry as
	 *       `GET /v1/archived-emails/{id}`, and returns the same thread. `text` is the plain-text body,
	 *       or a text rendering of the HTML body when the email has no plain-text part. Requires
	 *       `read:archive` permission.
	 *     operationId: getArchivedEmailContent
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         description: The ID of the archived email.
	 *         schema:
	 *           type: string
	 *       - name: includeHtml
	 *         in: query
	 *         required: false
	 *         description: Also return the HTML body in `html` (null when the email has none).
	 *         schema:
	 *           type: boolean
	 *           default: false
	 *       - name: includeAttachmentText
	 *         in: query
	 *         required: false
	 *         description: >-
	 *           Also return each attachment's text, as extracted when the email was indexed. The text
	 *           is null when the email is not indexed or nothing could be extracted.
	 *         schema:
	 *           type: boolean
	 *           default: false
	 *       - name: maxChars
	 *         in: query
	 *         required: false
	 *         description: Cut `text` to this many characters and set `truncated`. Unlimited when omitted.
	 *         schema:
	 *           type: integer
	 *           minimum: 1
	 *     responses:
	 *       '200':
	 *         description: The parsed email.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               required: [id, from, to, cc, bcc, sentAt, references, userEmail, text, attachments, thread, truncated]
	 *               properties:
	 *                 id:
	 *                   type: string
	 *                 subject:
	 *                   type: string
	 *                   nullable: true
	 *                 from:
	 *                   $ref: '#/components/schemas/Recipient'
	 *                 to:
	 *                   type: array
	 *                   items:
	 *                     $ref: '#/components/schemas/Recipient'
	 *                 cc:
	 *                   type: array
	 *                   items:
	 *                     $ref: '#/components/schemas/Recipient'
	 *                 bcc:
	 *                   type: array
	 *                   items:
	 *                     $ref: '#/components/schemas/Recipient'
	 *                 sentAt:
	 *                   type: string
	 *                   format: date-time
	 *                 messageId:
	 *                   type: string
	 *                   nullable: true
	 *                 inReplyTo:
	 *                   type: string
	 *                   nullable: true
	 *                 references:
	 *                   type: array
	 *                   items:
	 *                     type: string
	 *                 userEmail:
	 *                   type: string
	 *                   description: The mailbox the email belongs to.
	 *                 ingestionSource:
	 *                   type: object
	 *                   nullable: true
	 *                   properties:
	 *                     id:
	 *                       type: string
	 *                     name:
	 *                       type: string
	 *                 text:
	 *                   type: string
	 *                 html:
	 *                   type: string
	 *                   nullable: true
	 *                   description: Only present when `includeHtml=true`.
	 *                 attachments:
	 *                   type: array
	 *                   items:
	 *                     type: object
	 *                     properties:
	 *                       id:
	 *                         type: string
	 *                       filename:
	 *                         type: string
	 *                       mimeType:
	 *                         type: string
	 *                         nullable: true
	 *                       sizeBytes:
	 *                         type: integer
	 *                       text:
	 *                         type: string
	 *                         nullable: true
	 *                         description: Only present when `includeAttachmentText=true`.
	 *                 thread:
	 *                   type: array
	 *                   items:
	 *                     $ref: '#/components/schemas/ThreadEmail'
	 *                 truncated:
	 *                   type: boolean
	 *                   description: Whether `text` was cut to `maxChars`.
	 *       '400':
	 *         description: A flag is not `true` or `false`, or `maxChars` is not a positive whole number.
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
		'/:id/content',
		requirePermission('read', 'archive'),
		archivedEmailController.getArchivedEmailContent
	);

	router.delete(
		'/:id',
		requirePermission('delete', 'archive', { loadResource: archivedEmailResource }),
		archivedEmailController.deleteArchivedEmail
	);

	return router;
};
