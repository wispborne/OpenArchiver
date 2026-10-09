import { and, eq } from 'drizzle-orm';
import { db } from '../database';
import { mailboxAliases } from '../database/schema';

/**
 * How long an ingestion job trusts an alias lookup before asking again.
 *
 * Long enough that a mailbox job pays for one lookup per minute instead of one per email, short
 * enough that a merge performed while a sync is running is picked up by that sync within the
 * minute. The merge job waits this long before its final pass, so whatever a running sync wrote
 * under the old address before it noticed the alias is still moved.
 */
export const MAILBOX_ALIAS_CACHE_MS = 60_000;

/**
 * The mailbox an address is archived under within a merge group: the canonical mailbox when the
 * address was merged into one, otherwise the address itself.
 *
 * Both arguments must already be normalized; `rootSourceId` is the group root, the id every row of
 * the group is stored under. Aliases are kept flat, so one lookup is the whole answer.
 */
export const resolveMailboxAlias = async (
	rootSourceId: string,
	normalizedEmail: string
): Promise<string> => {
	const [row] = await db
		.select({ canonicalEmail: mailboxAliases.canonicalEmail })
		.from(mailboxAliases)
		.where(
			and(
				eq(mailboxAliases.ingestionSourceId, rootSourceId),
				eq(mailboxAliases.aliasEmail, normalizedEmail)
			)
		)
		.limit(1);
	return row?.canonicalEmail ?? normalizedEmail;
};

/**
 * A per-job memo over {@link resolveMailboxAlias}, expiring after {@link MAILBOX_ALIAS_CACHE_MS}.
 *
 * Promises are cached rather than values for the reason the other ingestion memos do it: emails of
 * one mailbox are archived concurrently, and the first callers should share one query. A failed
 * lookup is not remembered, so a database blip is retried by the next email instead of being
 * re-thrown at every remaining one.
 */
export class MailboxAliasCache {
	#entries = new Map<string, { value: Promise<string>; expiresAt: number }>();

	resolve(rootSourceId: string, normalizedEmail: string): Promise<string> {
		const key = `${rootSourceId}\u0000${normalizedEmail}`;
		const now = Date.now();
		const cached = this.#entries.get(key);
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}
		const value = resolveMailboxAlias(rootSourceId, normalizedEmail);
		this.#entries.set(key, { value, expiresAt: now + MAILBOX_ALIAS_CACHE_MS });
		value.catch(() => this.#entries.delete(key));
		return value;
	}
}
