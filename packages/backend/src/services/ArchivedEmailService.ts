import { count, desc, eq, asc, and, inArray, ne } from 'drizzle-orm';
import { db } from '../database';
import {
	archivedEmails,
	attachments,
	emailAttachments,
	ingestionSources,
} from '../database/schema';
import { FilterBuilder } from './FilterBuilder';
import { AuthorizationService } from './AuthorizationService';
import type {
	PaginatedArchivedEmails,
	ArchivedEmail,
	ArchivedEmailContent,
	ArchivedEmailContentOptions,
	Attachment,
	EmailDocument,
	Recipient,
	ThreadEmail,
} from '@open-archiver/types';
import { simpleParser } from 'mailparser';
import { StorageService } from './StorageService';
import { SearchService } from './SearchService';
import { IngestionService } from './IngestionService';
import type { Readable } from 'stream';
import { AuditService } from './AuditService';
import { User } from '@open-archiver/types';
import { checkDeletionEnabled } from '../helpers/deletionGuard';
import { RetentionHook } from '../hooks/RetentionHook';
import { logger } from '../config/logger';

interface DbRecipients {
	to: { name: string; address: string }[];
	cc: { name: string; address: string }[];
	bcc: { name: string; address: string }[];
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk) => chunks.push(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

/**
 * Cuts `text` to at most `maxChars` UTF-16 code units. A cut that would split a surrogate pair
 * (an emoji, say) drops the lone high half instead of returning a broken character.
 */
function truncateText(text: string, maxChars?: number): { text: string; truncated: boolean } {
	if (maxChars === undefined || text.length <= maxChars) {
		return { text, truncated: false };
	}
	let end = maxChars;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		end -= 1;
	}
	return { text: text.slice(0, end), truncated: true };
}

export class ArchivedEmailService {
	private static auditService = new AuditService();
	private static mapRecipients(dbRecipients: unknown): Recipient[] {
		const { to = [], cc = [], bcc = [] } = dbRecipients as DbRecipients;

		const allRecipients = [...to, ...cc, ...bcc];

		return allRecipients.map((r) => ({
			name: r.name,
			email: r.address,
		}));
	}

	public static async getArchivedEmails(
		ingestionSourceId: string,
		page: number,
		limit: number,
		userId: string
	): Promise<PaginatedArchivedEmails> {
		const offset = (page - 1) * limit;
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');

		// Expand to the full merge group so emails from children appear when browsing a root source
		const groupIds = await IngestionService.findGroupSourceIds(ingestionSourceId);
		const sourceFilter = IngestionService.groupScopeFilter(groupIds);
		const where = and(sourceFilter, drizzleFilter);

		const countQuery = db
			.select({
				count: count(archivedEmails.id),
			})
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id));

		if (where) {
			countQuery.where(where);
		}

		const [total] = await countQuery;

		const itemsQuery = db
			.select()
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.orderBy(desc(archivedEmails.sentAt))
			.limit(limit)
			.offset(offset);

		if (where) {
			itemsQuery.where(where);
		}

		const results = await itemsQuery;
		const items = results.map((r) => r.archived_emails);

		return {
			items: items.map((item) => ({
				...item,
				recipients: this.mapRecipients(item.recipients),
				tags: (item.tags as string[] | null) || null,
				path: item.path || null,
			})),
			total: total.count,
			page,
			limit,
		};
	}

	/**
	 * The stored row plus its source, for permission checks that need the record itself rather
	 * than the resource type.
	 */
	public static async findRowById(emailId: string) {
		return db.query.archivedEmails.findFirst({
			where: eq(archivedEmails.id, emailId),
			with: {
				ingestionSource: true,
			},
		});
	}

	/**
	 * Whether a file in the storage layer belongs to an email the user is allowed to read.
	 *
	 * The download endpoint takes a raw storage path, so the path has to be resolved back to a
	 * record before the archive policy can be applied to it. Attachments are stored once and
	 * shared by every message carrying the same bytes, so access is granted when *any* referencing
	 * email is visible to the user.
	 */
	public static async canAccessStoragePath(
		storagePath: string,
		userId: string
	): Promise<boolean> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');

		const [email] = await db
			.select({ id: archivedEmails.id })
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.where(and(eq(archivedEmails.storagePath, storagePath), drizzleFilter))
			.limit(1);

		if (email) {
			return true;
		}

		// Resolved in two steps on purpose: `attachments` also has an `ingestion_source_id`
		// column, and the permission filter names its columns unqualified, so joining that table
		// into the filtered query would make the reference ambiguous.
		const [attachment] = await db
			.select({ id: attachments.id })
			.from(attachments)
			.where(eq(attachments.storagePath, storagePath))
			.limit(1);

		if (!attachment) {
			return false;
		}

		const [carrier] = await db
			.select({ id: archivedEmails.id })
			.from(archivedEmails)
			.innerJoin(emailAttachments, eq(emailAttachments.emailId, archivedEmails.id))
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.where(and(eq(emailAttachments.attachmentId, attachment.id), drizzleFilter))
			.limit(1);

		return Boolean(carrier);
	}

	/**
	 * Loads an email for a reader: the permission check against the row, the `READ` audit entry,
	 * the thread siblings and the attachment rows. Every endpoint that returns an email's content
	 * goes through here, so a fix to how reads are authorised or audited applies to all of them.
	 *
	 * Returns `null` both when the email doesn't exist and when the user may not read it, so a
	 * caller can't tell the two apart (and can't probe for ids in mailboxes it can't see).
	 * `attachments` is `null` when the row says the email has none, which saves the query.
	 */
	private static async loadReadableEmail(
		emailId: string,
		userId: string,
		actor: User,
		actorIp: string
	) {
		const email = await this.findRowById(emailId);

		if (!email) {
			return null;
		}

		const authorizationService = new AuthorizationService();
		const canRead = await authorizationService.can(userId, 'read', 'archive', email);

		if (!canRead) {
			return null;
		}

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'READ',
			targetType: 'ArchivedEmail',
			targetId: emailId,
			actorIp,
			details: {},
		});

		let threadEmails: ThreadEmail[] = [];

		// Expand thread query to the full merge group so threads can span across merged sources
		if (email.threadId) {
			const groupIds = await IngestionService.findGroupSourceIds(email.ingestionSourceId);
			const sourceFilter = IngestionService.groupScopeFilter(groupIds);
			threadEmails = await db.query.archivedEmails.findMany({
				where: and(eq(archivedEmails.threadId, email.threadId), sourceFilter),
				orderBy: [asc(archivedEmails.sentAt)],
				columns: {
					id: true,
					subject: true,
					sentAt: true,
					senderName: true,
					senderEmail: true,
				},
			});
		}

		let emailAttachmentsResult: Attachment[] | null = null;
		if (email.hasAttachments) {
			emailAttachmentsResult = await db
				.select({
					id: attachments.id,
					filename: attachments.filename,
					mimeType: attachments.mimeType,
					sizeBytes: attachments.sizeBytes,
					storagePath: attachments.storagePath,
				})
				.from(emailAttachments)
				.innerJoin(attachments, eq(emailAttachments.attachmentId, attachments.id))
				.where(eq(emailAttachments.emailId, emailId));
		}

		return { email, thread: threadEmails, attachments: emailAttachmentsResult };
	}

	public static async getArchivedEmailById(
		emailId: string,
		userId: string,
		actor: User,
		actorIp: string
	): Promise<ArchivedEmail | null> {
		const loaded = await this.loadReadableEmail(emailId, userId, actor, actorIp);

		if (!loaded) {
			return null;
		}
		const { email } = loaded;

		const storage = new StorageService();
		const rawStream = await storage.get(email.storagePath);
		const raw = await streamToBuffer(rawStream as Readable);

		const mappedEmail = {
			...email,
			// Trim the joined ingestion source to just id + name; the full row carries
			// encrypted credentials that must never be sent to the client.
			ingestionSource: email.ingestionSource
				? { id: email.ingestionSource.id, name: email.ingestionSource.name }
				: null,
			recipients: this.mapRecipients(email.recipients),
			raw,
			thread: loaded.thread,
			tags: (email.tags as string[] | null) || null,
			path: email.path || null,
		};

		if (loaded.attachments) {
			return {
				...mappedEmail,
				attachments: loaded.attachments,
			};
		}

		return mappedEmail;
	}

	/**
	 * The email parsed on the server, for API clients that want readable text rather than the
	 * raw .eml (`GET /v1/archived-emails/{id}/content`). Authorisation, auditing and the thread
	 * are exactly those of {@link getArchivedEmailById}.
	 *
	 * Headers come from the database row where it has them, since that's what search and the
	 * rest of the UI show; only the reply headers and the bodies come from parsing the .eml.
	 * The stored .eml has its attachments stripped at ingestion (`stripAttachmentsFromEml`), so
	 * the attachment list always comes from the `attachments` table, never from the parse.
	 */
	public static async getArchivedEmailContent(
		emailId: string,
		userId: string,
		actor: User,
		actorIp: string,
		options: ArchivedEmailContentOptions = {}
	): Promise<ArchivedEmailContent | null> {
		const loaded = await this.loadReadableEmail(emailId, userId, actor, actorIp);

		if (!loaded) {
			return null;
		}
		const { email } = loaded;

		const storage = new StorageService();
		const rawStream = await storage.get(email.storagePath);
		const parsed = await simpleParser(await streamToBuffer(rawStream as Readable));

		// mailparser fills `text` from the HTML part (via html-to-text) when the email has no
		// plain-text part, so HTML-only mail needs no conversion here.
		const fullText = parsed.text ?? '';
		const { text, truncated } = truncateText(fullText, options.maxChars);

		const attachmentRows = loaded.attachments ?? [];
		const attachmentTexts = options.includeAttachmentText
			? await this.findIndexedAttachmentTexts(emailId, attachmentRows)
			: null;

		const { to = [], cc = [], bcc = [] } = (email.recipients ?? {}) as Partial<DbRecipients>;
		const toRecipients = (list: { name: string; address: string }[]): Recipient[] =>
			list.map((r) => ({ name: r.name, email: r.address }));
		const references = parsed.references
			? Array.isArray(parsed.references)
				? parsed.references
				: [parsed.references]
			: [];

		return {
			id: email.id,
			subject: email.subject,
			from: { name: email.senderName ?? undefined, email: email.senderEmail },
			to: toRecipients(to),
			cc: toRecipients(cc),
			bcc: toRecipients(bcc),
			sentAt: email.sentAt,
			messageId: email.messageIdHeader,
			inReplyTo: parsed.inReplyTo ?? null,
			references,
			userEmail: email.userEmail,
			ingestionSource: email.ingestionSource
				? { id: email.ingestionSource.id, name: email.ingestionSource.name }
				: null,
			text,
			...(options.includeHtml ? { html: parsed.html || null } : {}),
			attachments: attachmentRows.map((attachment, index) => ({
				id: attachment.id,
				filename: attachment.filename,
				mimeType: attachment.mimeType,
				sizeBytes: attachment.sizeBytes,
				...(attachmentTexts ? { text: attachmentTexts[index] } : {}),
			})),
			thread: loaded.thread,
			truncated,
		};
	}

	/**
	 * The text extracted from each attachment at indexing time, in the order of `rows`. It only
	 * exists in the email's Meilisearch document (the database keeps no attachment text), so an
	 * email that isn't indexed gets `null` for every attachment, as does an attachment nothing
	 * could be extracted from.
	 *
	 * The search document lists attachments by filename only, without the attachment's id, so
	 * rows are paired with entries by filename; two attachments with the same name pair up in the
	 * order they appear, which is the order both lists were built in.
	 *
	 * Reading the document directly is safe because the caller has already been authorised for
	 * this email; the search permission filter would add nothing.
	 */
	private static async findIndexedAttachmentTexts(
		emailId: string,
		rows: Attachment[]
	): Promise<(string | null)[]> {
		if (rows.length === 0) {
			return [];
		}

		let indexed: EmailDocument['attachments'] = [];
		try {
			const index = await new SearchService().getIndex<EmailDocument>('emails');
			const document = await index.getDocument(emailId, { fields: ['attachments'] });
			indexed = document.attachments ?? [];
		} catch (error) {
			// Not indexed yet (or the index doesn't exist yet): no text, but still a valid answer.
			// Anything else — Meilisearch down, say — is a real failure and must not be reported
			// as "not indexed".
			const code = (error as { cause?: { code?: string } })?.cause?.code;
			if (code !== 'document_not_found' && code !== 'index_not_found') {
				throw error;
			}
		}

		const remainingByName = new Map<string, string[]>();
		for (const entry of indexed) {
			const queue = remainingByName.get(entry.filename) ?? [];
			queue.push(entry.content);
			remainingByName.set(entry.filename, queue);
		}

		return rows.map((row) => remainingByName.get(row.filename)?.shift() || null);
	}

	public static async deleteArchivedEmail(
		emailId: string,
		actor: User,
		actorIp: string,
		options: {
			systemDelete?: boolean;
			/**
			 * Human-readable name of the retention rule that triggered deletion
			 */
			governingRule?: string;
		} = {}
	): Promise<void> {
		checkDeletionEnabled({ allowSystemDelete: options.systemDelete });

		const canDelete = await RetentionHook.canDelete(emailId);
		if (!canDelete) {
			throw new Error('Deletion blocked by retention policy (Legal Hold or similar).');
		}

		const [email] = await db
			.select()
			.from(archivedEmails)
			.where(eq(archivedEmails.id, emailId));

		if (!email) {
			throw new Error('Archived email not found');
		}

		const storage = new StorageService();

		// Load and handle attachments before deleting the email itself
		if (email.hasAttachments) {
			const attachmentsForEmail = await db
				.select({
					attachmentId: attachments.id,
					storagePath: attachments.storagePath,
				})
				.from(emailAttachments)
				.innerJoin(attachments, eq(emailAttachments.attachmentId, attachments.id))
				.where(eq(emailAttachments.emailId, emailId));

			try {
				for (const attachment of attachmentsForEmail) {
					// Delete the link between this email and the attachment record.
					await db
						.delete(emailAttachments)
						.where(
							and(
								eq(emailAttachments.emailId, emailId),
								eq(emailAttachments.attachmentId, attachment.attachmentId)
							)
						);

					// Check if any other emails are linked to this attachment record.
					const [recordRefCount] = await db
						.select({ count: count() })
						.from(emailAttachments)
						.where(eq(emailAttachments.attachmentId, attachment.attachmentId));

					// If no other emails are linked to this record, it's safe to delete it and the file.
					if (recordRefCount.count === 0) {
						await storage.delete(attachment.storagePath);
						await db
							.delete(attachments)
							.where(eq(attachments.id, attachment.attachmentId));
					}
				}
			} catch (error) {
				logger.error(
					{
						emailId,
						error: error instanceof Error ? error.message : String(error),
					},
					'Failed to delete email attachments'
				);
				throw new Error('Failed to delete email attachments');
			}
		}

		// Only delete the physical EML file if no other archived_emails row shares
		// the same storagePath. Multiple rows can point to the same file when
		// per-mailbox archiving creates shared-file reference rows.
		const [emlRefCount] = await db
			.select({ count: count() })
			.from(archivedEmails)
			.where(
				and(
					eq(archivedEmails.storagePath, email.storagePath),
					ne(archivedEmails.id, emailId)
				)
			);

		if (emlRefCount.count === 0) {
			await storage.delete(email.storagePath);
		}

		// Confirmed before the row goes, rather than only enqueued. Once the row is deleted nothing
		// can rebuild this document or even name it, so a delete task that fails afterwards strands
		// it in the index and search offers a result that cannot be opened (#446). Throwing here
		// leaves the email intact and the operation repeatable.
		const searchService = new SearchService();
		const deletionTask = await searchService.deleteDocuments('emails', [emailId]);
		await searchService.waitForTask(deletionTask.taskUid);

		await db.delete(archivedEmails).where(eq(archivedEmails.id, emailId));

		// Build audit details: system-initiated deletions carry retention context
		// for GoBD compliance; manual deletions record only the reason.
		const auditDetails: Record<string, unknown> = {
			reason: options.systemDelete ? 'RetentionExpiration' : 'ManualDeletion',
		};
		if (options.systemDelete && options.governingRule) {
			auditDetails.governingRule = options.governingRule;
		}

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'DELETE',
			targetType: 'ArchivedEmail',
			targetId: emailId,
			actorIp,
			details: auditDetails,
		});
	}
}
