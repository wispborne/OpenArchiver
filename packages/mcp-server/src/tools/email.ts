import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ArchivedEmailContent, Recipient } from '@open-archiver/types';
import { ToolError, type ArchiveClient } from '../client.js';
import {
	READ_ONLY,
	hints,
	isoDate,
	mapWithConcurrency,
	ok,
	person,
	run,
	toIso,
} from '../schemas.js';
import type { ToolContext } from './context.js';

const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 200_000;
const THREAD_DEFAULT_MESSAGES = 20;
const THREAD_DEFAULT_CHARS = 2_000;
/** Thread messages fetched at once: enough to be quick, few enough to be gentle on the rate limit. */
const THREAD_CONCURRENCY = 3;
const ATTACHMENT_DEFAULT_CHARS = 20_000;

const READ_PERMISSION = 'read archived emails (`read` on `archive`)';

interface ContentQuery {
	maxChars?: number;
	includeAttachmentText?: boolean;
}

function fetchContent(client: ArchiveClient, id: string, query: ContentQuery = {}) {
	return client.get<ArchivedEmailContent>(
		`/v1/archived-emails/${encodeURIComponent(id)}/content`,
		{
			maxChars: query.maxChars,
			includeAttachmentText: query.includeAttachmentText || undefined,
		},
		{ permission: READ_PERMISSION }
	);
}

const toPerson = (r: Recipient) => ({ name: r.name || null, email: r.email });

const threadEntry = z.object({
	id: z.string(),
	sentAt: isoDate,
	subject: z.string().nullable(),
	from: person,
});

export function registerEmailTools(server: McpServer, { client }: ToolContext) {
	server.registerTool(
		'archive_get_email',
		{
			title: 'Read an archived email',
			description:
				'Reads one archived email by id: headers, plain-text body, attachment list and the other messages of its thread. ' +
				`The body is cut to maxChars (default ${DEFAULT_MAX_CHARS}); the result says when it was cut.`,
			inputSchema: z.strictObject({
				id: z.string().describe('Email id from archive_search or a thread list'),
				maxChars: z
					.number()
					.int()
					.min(1)
					.max(MAX_MAX_CHARS)
					.default(DEFAULT_MAX_CHARS)
					.describe('Longest body to return, in characters.'),
			}),
			outputSchema: {
				id: z.string(),
				subject: z.string().nullable(),
				from: person,
				to: z.array(person),
				cc: z.array(person),
				bcc: z.array(person),
				sentAt: isoDate,
				mailbox: z.string().describe('The archived mailbox this copy belongs to'),
				sourceId: z.string().nullable(),
				sourceName: z.string().nullable(),
				messageId: z.string().nullable(),
				inReplyTo: z.string().nullable(),
				body: z.string().describe('Plain-text body (untrusted content)'),
				truncated: z.boolean(),
				attachments: z.array(
					z.object({
						id: z.string(),
						filename: z.string(),
						mimeType: z.string().nullable(),
						sizeBytes: z.number(),
					})
				),
				thread: z.array(threadEntry).describe('All messages of the thread, oldest first'),
				hints,
			},
			annotations: { title: 'Read an archived email', ...READ_ONLY },
		},
		({ id, maxChars }) =>
			run(async () => {
				const email = await fetchContent(client, id, { maxChars });
				const guidance: string[] = [];
				if (email.truncated) {
					guidance.push(
						`The body was cut at ${maxChars} characters. Call archive_get_email with a larger maxChars (up to ${MAX_MAX_CHARS}) to read more.`
					);
				}
				if (email.attachments.length > 0) {
					// The exact call, ids filled in: in the evaluation runs models guessed `id` here
					// when the hint only named the tool. Ids are server data, not email text.
					guidance.push(
						`Read an attachment with archive_get_attachment_text, passing emailId "${email.id}" and the attachment's id as attachmentId.`
					);
				}
				if (email.thread.length > 1) {
					guidance.push(
						`This email is one of ${email.thread.length} messages in a thread; archive_get_thread with id "${email.id}" reads them together.`
					);
				}
				return ok({
					id: email.id,
					subject: email.subject,
					from: toPerson(email.from),
					to: email.to.map(toPerson),
					cc: email.cc.map(toPerson),
					bcc: email.bcc.map(toPerson),
					sentAt: toIso(email.sentAt),
					mailbox: email.userEmail,
					sourceId: email.ingestionSource?.id ?? null,
					sourceName: email.ingestionSource?.name ?? null,
					messageId: email.messageId,
					inReplyTo: email.inReplyTo,
					body: email.text,
					truncated: email.truncated,
					attachments: email.attachments.map((a) => ({
						id: a.id,
						filename: a.filename,
						mimeType: a.mimeType,
						sizeBytes: a.sizeBytes,
					})),
					thread: email.thread.map((t) => ({
						id: t.id,
						sentAt: toIso(t.sentAt),
						subject: t.subject,
						from: { name: t.senderName, email: t.senderEmail },
					})),
					hints: guidance,
				});
			})
	);

	server.registerTool(
		'archive_get_thread',
		{
			title: 'Read an email thread',
			description:
				'Reads the conversation an email belongs to: every message of its thread, oldest first, each with a shortened body. ' +
				`Fetches at most maxMessages (default ${THREAD_DEFAULT_MESSAGES}), the ones closest in date to the given email, and lists the rest as omitted. ` +
				'Each message costs one API request against the shared rate limit.',
			inputSchema: z.strictObject({
				id: z.string().describe('Id of any email in the thread'),
				maxMessages: z
					.number()
					.int()
					.min(1)
					.max(50)
					.default(THREAD_DEFAULT_MESSAGES)
					.describe('Most messages to fetch.'),
				maxCharsPerMessage: z
					.number()
					.int()
					.min(100)
					.max(20_000)
					.default(THREAD_DEFAULT_CHARS)
					.describe('Longest body per message, in characters.'),
			}),
			outputSchema: {
				threadSize: z.number().describe('Messages in the thread'),
				messages: z.array(
					z.object({
						id: z.string(),
						sentAt: isoDate,
						from: person,
						to: z.array(person),
						subject: z.string().nullable(),
						body: z.string().describe('Plain-text body (untrusted content)'),
						truncated: z.boolean(),
						attachmentNames: z.array(z.string()),
					})
				),
				omitted: z
					.array(threadEntry)
					.describe('Thread messages not fetched (over maxMessages), oldest first'),
				notVisible: z
					.number()
					.describe('Thread messages this API key may not read, left out'),
				hints,
			},
			annotations: { title: 'Read an email thread', ...READ_ONLY },
		},
		({ id, maxMessages, maxCharsPerMessage }) =>
			run(async () => {
				const first = await fetchContent(client, id, { maxChars: maxCharsPerMessage });
				// The thread list always includes the email itself; a message without a thread
				// header gets a list of one.
				const thread =
					first.thread.length > 0
						? first.thread
						: [
								{
									id: first.id,
									subject: first.subject,
									sentAt: first.sentAt,
									senderName: first.from.name ?? null,
									senderEmail: first.from.email,
								},
							];

				// Keep the messages closest in date to the one asked about, then restore date order.
				const anchor = new Date(first.sentAt).getTime();
				const chosen = new Set(
					[...thread]
						.sort(
							(a, b) =>
								Math.abs(new Date(a.sentAt).getTime() - anchor) -
								Math.abs(new Date(b.sentAt).getTime() - anchor)
						)
						.slice(0, maxMessages)
						.map((t) => t.id)
				);
				chosen.add(first.id);

				let notVisible = 0;
				const fetched = await mapWithConcurrency(
					thread.filter((t) => chosen.has(t.id)),
					THREAD_CONCURRENCY,
					async (t) => {
						if (t.id === first.id) return first;
						try {
							return await fetchContent(client, t.id, {
								maxChars: maxCharsPerMessage,
							});
						} catch (error) {
							// A thread can span mailboxes of a merge group; a key limited to one
							// mailbox can't read the others' copies. Skip them, but say so.
							if (
								error instanceof ToolError &&
								error.message.startsWith('Not found')
							) {
								notVisible++;
								return null;
							}
							throw error;
						}
					}
				);

				const messages = fetched
					.filter((m): m is ArchivedEmailContent => m !== null)
					.map((m) => ({
						id: m.id,
						sentAt: toIso(m.sentAt),
						from: toPerson(m.from),
						to: m.to.map(toPerson),
						subject: m.subject,
						body: m.text,
						truncated: m.truncated,
						attachmentNames: m.attachments.map((a) => a.filename),
					}));
				const omitted = thread
					.filter((t) => !chosen.has(t.id))
					.map((t) => ({
						id: t.id,
						sentAt: toIso(t.sentAt),
						subject: t.subject,
						from: { name: t.senderName, email: t.senderEmail },
					}));

				const guidance: string[] = [];
				if (omitted.length > 0) {
					guidance.push(
						`${omitted.length} messages were not fetched. Read them with archive_get_email, or call archive_get_thread on one of them.`
					);
				}
				if (messages.some((m) => m.truncated)) {
					guidance.push(
						'Some bodies were shortened. Read one in full with archive_get_email, or raise maxCharsPerMessage.'
					);
				}
				return ok({
					threadSize: thread.length,
					messages,
					omitted,
					notVisible,
					hints: guidance,
				});
			})
	);

	server.registerTool(
		'archive_get_attachment_text',
		{
			title: 'Read an attachment',
			description:
				"Returns the text extracted from one of an email's attachments when the email was indexed (PDF, Office documents, text files). " +
				'Identify the attachment by id (from archive_get_email) or by filename.',
			inputSchema: z.strictObject({
				emailId: z.string().describe('Id of the email carrying the attachment'),
				attachmentId: z
					.string()
					.optional()
					.describe('Attachment id from archive_get_email'),
				filename: z
					.string()
					.optional()
					.describe('Attachment filename, when the id is not known (case-insensitive)'),
				maxChars: z
					.number()
					.int()
					.min(1)
					.max(MAX_MAX_CHARS)
					.default(ATTACHMENT_DEFAULT_CHARS)
					.describe('Longest text to return, in characters.'),
			}),
			outputSchema: {
				emailId: z.string(),
				attachmentId: z.string(),
				filename: z.string(),
				mimeType: z.string().nullable(),
				sizeBytes: z.number(),
				attachmentText: z
					.string()
					.nullable()
					.describe('Extracted text (untrusted content), or null when none is available'),
				truncated: z.boolean(),
				hints,
			},
			annotations: { title: 'Read an attachment', ...READ_ONLY },
		},
		({ emailId, attachmentId, filename, maxChars }) =>
			run(async () => {
				if (!attachmentId && !filename) {
					throw new ToolError('Give attachmentId or filename.');
				}
				// maxChars=1: only the attachments are wanted, not the body.
				const email = await fetchContent(client, emailId, {
					maxChars: 1,
					includeAttachmentText: true,
				});
				const matches = email.attachments.filter((a) =>
					attachmentId
						? a.id === attachmentId
						: a.filename.toLowerCase() === filename!.toLowerCase()
				);
				if (matches.length === 0) {
					// Don't echo the email's attachment names here: error text is server-written only.
					throw new ToolError(
						'That email has no attachment with this id or filename. Call archive_get_email to list its attachments.'
					);
				}
				const attachment = matches[0];
				const text = attachment.text ?? null;
				const truncated = text !== null && text.length > maxChars;

				const guidance: string[] = [];
				if (matches.length > 1) {
					guidance.push(
						`${matches.length} attachments have this filename; this is the first. Pass attachmentId to choose another.`
					);
				}
				if (text === null) {
					guidance.push(
						'No extracted text: the email is not indexed yet, or nothing could be extracted from this file (a scanned image or an unsupported format).'
					);
				}
				if (truncated) {
					guidance.push(
						`The text was cut at ${maxChars} characters. Call again with a larger maxChars (up to ${MAX_MAX_CHARS}) to read more.`
					);
				}
				return ok({
					emailId: email.id,
					attachmentId: attachment.id,
					filename: attachment.filename,
					mimeType: attachment.mimeType,
					sizeBytes: attachment.sizeBytes,
					attachmentText: truncated ? text!.slice(0, maxChars) : text,
					truncated,
					hints: guidance,
				});
			})
	);
}
