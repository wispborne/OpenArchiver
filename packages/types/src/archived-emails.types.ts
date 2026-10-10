/**
 * Represents a single recipient of an email.
 */
export interface Recipient {
	name?: string;
	email: string;
}

/**
 * Represents a single attachment of an email.
 */
export interface Attachment {
	id: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	storagePath: string;
}

export interface ThreadEmail {
	id: string; //the archivedemail id
	subject: string | null;
	sentAt: Date;
	senderName: string | null;
	senderEmail: string;
}

/**
 * Represents a single archived email.
 */
export interface ArchivedEmail {
	id: string;
	ingestionSourceId: string;
	/** The ingestion source this email belongs to, when loaded (e.g. the detail view). */
	ingestionSource?: { id: string; name: string } | null;
	userEmail: string;
	messageIdHeader: string | null;
	sentAt: Date;
	subject: string | null;
	senderName: string | null;
	senderEmail: string;
	recipients: Recipient[];
	storagePath: string;
	storageHashSha256: string;
	sizeBytes: number;
	isIndexed: boolean;
	/** Number of times indexing has been attempted and failed for this email.
	 * Used by the reconcile job to stop retrying persistently-failing ("poison") emails. */
	indexAttempts?: number;
	hasAttachments: boolean;
	isOnLegalHold: boolean;
	isJournaled: boolean | null;
	archivedAt: Date;
	attachments?: Attachment[];
	raw?: Buffer;
	thread?: ThreadEmail[];
	path: string | null;
	tags: string[] | null;
}

/**
 * Represents a paginated list of archived emails.
 */
export interface PaginatedArchivedEmails {
	items: ArchivedEmail[];
	total: number;
	page: number;
	limit: number;
}

/**
 * One attachment in an {@link ArchivedEmailContent} response. `text` is only present when the
 * request asked for attachment text; it is `null` when the email is not indexed or nothing could
 * be extracted from this attachment.
 */
export interface ArchivedEmailContentAttachment {
	id: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	text?: string | null;
}

/**
 * An archived email parsed on the server, returned by `GET /v1/archived-emails/{id}/content`.
 * Unlike {@link ArchivedEmail} it carries readable text instead of the raw .eml bytes, which is
 * what API clients such as the MCP server need.
 */
export interface ArchivedEmailContent {
	id: string;
	subject: string | null;
	from: Recipient;
	to: Recipient[];
	cc: Recipient[];
	bcc: Recipient[];
	sentAt: Date;
	messageId: string | null;
	inReplyTo: string | null;
	references: string[];
	userEmail: string;
	ingestionSource: { id: string; name: string } | null;
	/** The plain-text body, or a text rendering of the HTML body when there is no text part. */
	text: string;
	/** Only present when requested with `includeHtml=true`; `null` when the email has no HTML part. */
	html?: string | null;
	attachments: ArchivedEmailContentAttachment[];
	thread: ThreadEmail[];
	/** Whether `text` was cut to `maxChars`. */
	truncated: boolean;
}

export interface ArchivedEmailContentOptions {
	includeHtml?: boolean;
	includeAttachmentText?: boolean;
	/** Cut `text` to this many characters. Unlimited when omitted. */
	maxChars?: number;
}
