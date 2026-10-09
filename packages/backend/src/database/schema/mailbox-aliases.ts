import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ingestionSources } from './ingestion-sources';
import { users } from './users';

/**
 * Mailboxes merged into another mailbox of the same merge group.
 *
 * Keyed on the group's root source, because that is the id every archived row of the group is
 * stored under. Addresses are stored normalized (see normalizeEmailAddress). The table is kept flat
 * the same way merge groups are: a canonical mailbox is never itself an alias, so resolving an
 * address is one lookup and never a chain.
 *
 * The row is what makes a merge stick after it has run: ingestion maps `aliasEmail` to
 * `canonicalEmail` before deduplicating and storing, so mail still synced from the merged
 * provider mailbox keeps landing in the mailbox it was merged into.
 */
export const mailboxAliases = pgTable(
	'mailbox_aliases',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ingestionSourceId: uuid('ingestion_source_id')
			.notNull()
			.references(() => ingestionSources.id, { onDelete: 'cascade' }),
		aliasEmail: text('alias_email').notNull(),
		canonicalEmail: text('canonical_email').notNull(),
		createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex('mailbox_alias_source_alias_idx').on(table.ingestionSourceId, table.aliasEmail),
		index('mailbox_alias_source_canonical_idx').on(
			table.ingestionSourceId,
			table.canonicalEmail
		),
	]
);

export const mailboxAliasesRelations = relations(mailboxAliases, ({ one }) => ({
	ingestionSource: one(ingestionSources, {
		fields: [mailboxAliases.ingestionSourceId],
		references: [ingestionSources.id],
	}),
}));
