import type { EmailObject } from '@open-archiver/types';

/**
 * Removes NUL characters, which Postgres cannot store in a text value.
 *
 * Mail decoders pass them through from bodies and headers whose charset declaration was wrong. One
 * in a subject or display name failed the whole insert with "invalid byte sequence for encoding
 * UTF8: 0x00" (SQLSTATE 22021), and the message was never archived. Worse, an IMAP sync still
 * advanced past it, so no later sync tried again. Seen on 2015 mail from ups.com, among others.
 */
export const stripNul = <T extends string | null | undefined>(value: T): T =>
	(typeof value === 'string' && value.includes('\u0000')
		? value.replace(/\u0000/g, '')
		: value) as T;

/**
 * Strips NULs, in place, from every part of a parsed email that is written to a database column:
 * subject, addresses and display names, thread and provider ids, folder path, the Message-ID
 * header, and attachment names and types. The stored .eml and the attachment bytes are left as they
 * arrived, so the archive still holds the original message.
 */
export const stripNulFromEmail = (email: EmailObject): void => {
	email.id = stripNul(email.id);
	email.threadId = stripNul(email.threadId);
	email.subject = stripNul(email.subject);
	email.path = stripNul(email.path);
	for (const list of [email.from, email.to, email.cc, email.bcc]) {
		for (const address of list ?? []) {
			address.name = stripNul(address.name);
			address.address = stripNul(address.address);
		}
	}
	for (const attachment of email.attachments ?? []) {
		attachment.filename = stripNul(attachment.filename);
		attachment.contentType = stripNul(attachment.contentType);
	}
	const messageId = email.headers?.get('message-id');
	if (typeof messageId === 'string') {
		email.headers.set('message-id', stripNul(messageId));
	} else if (Array.isArray(messageId)) {
		email.headers.set(
			'message-id',
			messageId.map((v) => (typeof v === 'string' ? stripNul(v) : v))
		);
	}
};
