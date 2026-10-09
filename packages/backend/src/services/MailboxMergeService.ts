import { setTimeout as sleep } from 'timers/promises';
import { and, asc, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type {
	IMergeMailboxesJob,
	IMergeMailboxesResult,
	IUnmergeMailboxJob,
	MailboxAlias,
	MailboxMergeBlockedReason,
	MailboxMergePreview,
	User,
} from '@open-archiver/types';
import { db } from '../database';
import { archivedEmails, ingestionSources, mailboxAliases } from '../database/schema';
import { IngestionService, matchesMailbox } from './IngestionService';
import { ArchiveMaintenanceService } from './ArchiveMaintenanceService';
import { AuditService } from './AuditService';
import { indexingQueue } from '../jobs/queues';
import { claimJobId, isJobLive } from '../jobs/helpers/claimJobId';
import { isIndexingWorkerAlive } from '../jobs/helpers/workerLiveness';
import { normalizeEmailAddress } from '../helpers/emailAddress';
import { MAILBOX_ALIAS_CACHE_MS, resolveMailboxAlias } from '../helpers/mailboxAlias';
import { config } from '../config';
import { logger } from '../config/logger';

/** Rows moved per UPDATE, and so per index-email-batch job enqueued behind it. */
const MOVE_BATCH_SIZE = config.meili.indexingBatchSize;

/**
 * How long the merge job waits before its final pass: long enough for every running ingestion job
 * to have dropped its cached view of the aliases (see MAILBOX_ALIAS_CACHE_MS), plus a margin.
 */
const SETTLE_DELAY_MS = MAILBOX_ALIAS_CACHE_MS + 5_000;

/** Why a merge or unmerge request was refused. `reason` is what the controller maps to a status. */
export class MailboxMergeError extends Error {
	constructor(
		public readonly reason: MailboxMergeBlockedReason | 'not_merged' | 'deletion_disabled',
		message: string
	) {
		super(message);
	}
}

/**
 * Merges one mailbox of a merge group into another, and undoes it.
 *
 * A mailbox is the `user_email` of archived rows, and every row of a merge group is stored under the
 * group's root source, so a merge is two things, both keyed on the root:
 *
 *  1. An alias row (`mailbox_aliases`), so that ingestion archives whatever is still synced from the
 *     merged mailbox under the mailbox it was merged into.
 *  2. A rewrite of the rows already archived, done by a job because a mailbox can hold millions.
 *     Each moved row remembers the provider mailbox in `original_user_email`, which is what an
 *     unmerge moves back. Nothing in storage moves: the stored path never contained the mailbox.
 *
 * Aliases are kept flat, like merge groups: merging B into C repoints every alias that pointed at B,
 * and merging into an address that is itself an alias follows it to its canonical mailbox.
 *
 * Both jobs for a group run under one job id, so a merge and an unmerge of the same group can never
 * overlap, and neither starts while a source of the group is syncing.
 */
export class MailboxMergeService {
	private static auditService = new AuditService();

	static jobIdFor(rootSourceId: string): string {
		return `mailbox-merge-${rootSourceId}`;
	}

	/** The root of the merge group a source belongs to. */
	static async resolveRootId(sourceId: string): Promise<string> {
		const source = await IngestionService.findRowById(sourceId);
		if (!source) {
			throw new Error('Ingestion source not found');
		}
		return source.mergedIntoId ?? source.id;
	}

	static async listAliases(rootSourceId: string): Promise<MailboxAlias[]> {
		return db
			.select({
				aliasEmail: mailboxAliases.aliasEmail,
				canonicalEmail: mailboxAliases.canonicalEmail,
				createdAt: mailboxAliases.createdAt,
				createdBy: mailboxAliases.createdBy,
			})
			.from(mailboxAliases)
			.where(eq(mailboxAliases.ingestionSourceId, rootSourceId))
			.orderBy(asc(mailboxAliases.createdAt));
	}

	/**
	 * Works out where a merge would land and whether it may run now.
	 *
	 * `into` comes back resolved through the existing aliases. Re-running a merge whose alias is
	 * already in place is allowed on purpose: it is how a merge whose job failed part-way is finished.
	 */
	static async #plan(
		rootSourceId: string,
		from: string,
		requestedInto: string
	): Promise<{ into: string; blockedReason: MailboxMergeBlockedReason | null }> {
		const into = await resolveMailboxAlias(rootSourceId, requestedInto);
		if (from === requestedInto) {
			return { into, blockedReason: 'same_mailbox' };
		}
		if (from === into) {
			// The requested target was merged into `from` earlier; following it would point the
			// mailbox at itself.
			return { into, blockedReason: 'circular' };
		}
		const fromCanonical = await resolveMailboxAlias(rootSourceId, from);
		if (fromCanonical !== from && fromCanonical !== into) {
			return { into, blockedReason: 'already_merged' };
		}
		const blockedReason = await this.#busyReason(rootSourceId);
		return { into, blockedReason };
	}

	/**
	 * Refuses while the group is busy. A merge or unmerge already queued would race this one's row
	 * moves. A running sync is refused too: it would keep writing under the old address until its
	 * alias memo expires, and although the final pass catches that, it is simpler not to start.
	 */
	static async #busyReason(rootSourceId: string): Promise<MailboxMergeBlockedReason | null> {
		if (await isJobLive(indexingQueue, this.jobIdFor(rootSourceId))) {
			return 'merge_running';
		}
		const groupIds = await IngestionService.findGroupSourceIds(rootSourceId, {
			id: rootSourceId,
			mergedIntoId: null,
		});
		const [busy] = await db
			.select({ id: ingestionSources.id })
			.from(ingestionSources)
			.where(
				and(
					inArray(ingestionSources.id, groupIds),
					inArray(ingestionSources.status, ['syncing', 'importing'])
				)
			)
			.limit(1);
		return busy ? 'sync_running' : null;
	}

	static async preview(
		sourceId: string,
		rawFrom: string,
		rawInto: string
	): Promise<MailboxMergePreview> {
		const rootSourceId = await this.resolveRootId(sourceId);
		const from = normalizeEmailAddress(rawFrom);
		const { into, blockedReason } = await this.#plan(
			rootSourceId,
			from,
			normalizeEmailAddress(rawInto)
		);
		const groupIds = await IngestionService.findGroupSourceIds(rootSourceId, {
			id: rootSourceId,
			mergedIntoId: null,
		});
		const groupFilter = IngestionService.groupScopeFilter(groupIds);

		const messageIdsOf = (mailbox: string) =>
			db
				.select({ messageIdHeader: archivedEmails.messageIdHeader })
				.from(archivedEmails)
				.where(
					and(
						groupFilter,
						matchesMailbox(mailbox),
						isNotNull(archivedEmails.messageIdHeader)
					)
				);

		const [[moving], [existing], [duplicates]] = await Promise.all([
			db
				.select({ count: count() })
				.from(archivedEmails)
				.where(and(groupFilter, matchesMailbox(from))),
			db
				.select({ id: archivedEmails.id })
				.from(archivedEmails)
				.where(and(groupFilter, matchesMailbox(into)))
				.limit(1),
			db
				.select({ count: count() })
				.from(messageIdsOf(from).intersect(messageIdsOf(into)).as('shared')),
		]);

		return {
			from,
			into,
			intoExists: Boolean(existing),
			emailsToMove: moving?.count ?? 0,
			duplicateMessages: duplicates?.count ?? 0,
			deletionEnabled: config.app.enableDeletion,
			blockedReason,
		};
	}

	/**
	 * Records the alias and queues the job that moves the rows.
	 *
	 * The alias goes in first, before any row moves, so mail synced from the merged mailbox from
	 * here on already lands in the right place and the job's passes only ever shrink the set.
	 */
	static async merge(
		sourceId: string,
		rawFrom: string,
		rawInto: string,
		collapseDuplicates: boolean,
		actor: User,
		actorIp: string
	): Promise<{ into: string; workerAlive: boolean }> {
		const rootSourceId = await this.resolveRootId(sourceId);
		const from = normalizeEmailAddress(rawFrom);
		const requestedInto = normalizeEmailAddress(rawInto);
		if (collapseDuplicates && !config.app.enableDeletion) {
			throw new MailboxMergeError(
				'deletion_disabled',
				'Removing duplicate copies needs deletion to be enabled.'
			);
		}

		const into = await db.transaction(async (tx) => {
			// Serializes merges of one group, so two requests cannot each pass the checks below
			// and leave the aliases pointing in a circle.
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${this.jobIdFor(rootSourceId)}))`
			);
			const plan = await this.#plan(rootSourceId, from, requestedInto);
			if (plan.blockedReason) {
				throw new MailboxMergeError(
					plan.blockedReason,
					`Cannot merge: ${plan.blockedReason}`
				);
			}
			await tx
				.insert(mailboxAliases)
				.values({
					ingestionSourceId: rootSourceId,
					aliasEmail: from,
					canonicalEmail: plan.into,
					createdBy: actor.id,
				})
				.onConflictDoNothing();
			// Keeps the table flat: whatever was merged into `from` now points straight at its
			// new canonical mailbox.
			await tx
				.update(mailboxAliases)
				.set({ canonicalEmail: plan.into })
				.where(
					and(
						eq(mailboxAliases.ingestionSourceId, rootSourceId),
						eq(mailboxAliases.canonicalEmail, from)
					)
				);
			return plan.into;
		});

		const jobId = this.jobIdFor(rootSourceId);
		// Frees the id of a finished earlier run so this add is not silently dropped as a duplicate.
		await claimJobId(indexingQueue, jobId);
		const payload: IMergeMailboxesJob = {
			rootSourceId,
			from,
			into,
			collapseDuplicates,
			actorId: actor.id,
			actorIp,
		};
		await indexingQueue.add('merge-mailboxes', payload, { jobId, attempts: 1 });

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'UPDATE',
			targetType: 'IngestionSource',
			targetId: rootSourceId,
			actorIp,
			details: { action: 'merge-mailboxes', from, into, collapseDuplicates },
		});

		return { into, workerAlive: await isIndexingWorkerAlive() };
	}

	/**
	 * Removes a mailbox's alias and queues the job that moves its rows back out.
	 *
	 * Accepted when the alias is already gone but rows still remember the mailbox, so an unmerge
	 * whose job failed part-way can be finished by asking again.
	 */
	static async unmerge(
		sourceId: string,
		rawMailbox: string,
		actor: User,
		actorIp: string
	): Promise<{ workerAlive: boolean }> {
		const rootSourceId = await this.resolveRootId(sourceId);
		const mailbox = normalizeEmailAddress(rawMailbox);
		const groupIds = await IngestionService.findGroupSourceIds(rootSourceId, {
			id: rootSourceId,
			mergedIntoId: null,
		});

		await db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${this.jobIdFor(rootSourceId)}))`
			);
			const busy = await this.#busyReason(rootSourceId);
			if (busy) {
				throw new MailboxMergeError(busy, `Cannot unmerge: ${busy}`);
			}
			const removed = await tx
				.delete(mailboxAliases)
				.where(
					and(
						eq(mailboxAliases.ingestionSourceId, rootSourceId),
						eq(mailboxAliases.aliasEmail, mailbox)
					)
				)
				.returning({ id: mailboxAliases.id });
			if (removed.length === 0) {
				const [moved] = await tx
					.select({ id: archivedEmails.id })
					.from(archivedEmails)
					.where(
						and(
							IngestionService.groupScopeFilter(groupIds),
							eq(archivedEmails.originalUserEmail, mailbox)
						)
					)
					.limit(1);
				if (!moved) {
					throw new MailboxMergeError(
						'not_merged',
						`${mailbox} is not merged into another mailbox.`
					);
				}
			}
		});

		const jobId = this.jobIdFor(rootSourceId);
		await claimJobId(indexingQueue, jobId);
		const payload: IUnmergeMailboxJob = { rootSourceId, mailbox, actorId: actor.id, actorIp };
		await indexingQueue.add('unmerge-mailbox', payload, { jobId, attempts: 1 });

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'UPDATE',
			targetType: 'IngestionSource',
			targetId: rootSourceId,
			actorIp,
			details: { action: 'unmerge-mailbox', mailbox },
		});

		return { workerAlive: await isIndexingWorkerAlive() };
	}

	/** The body of the `merge-mailboxes` job. */
	static async runMerge(job: IMergeMailboxesJob, actor: User): Promise<IMergeMailboxesResult> {
		const { rootSourceId, from, into } = job;
		const groupIds = await IngestionService.findGroupSourceIds(rootSourceId, {
			id: rootSourceId,
			mergedIntoId: null,
		});
		const fromRows = and(IngestionService.groupScopeFilter(groupIds), matchesMailbox(from));
		const set = {
			userEmail: into,
			// The first move records the provider mailbox; a later one (this mailbox merged on
			// again) keeps it. Cleared when the row lands back where it came from.
			originalUserEmail: sql`nullif(coalesce(${archivedEmails.originalUserEmail}, lower(btrim(${archivedEmails.userEmail}))), ${into})`,
		};

		let moved = await this.#moveRows(fromRows, set);
		// A sync that started before the alias existed may still be writing under `from` until
		// its alias memo expires. Waiting that out and sweeping once more catches those rows.
		await sleep(SETTLE_DELAY_MS);
		moved += await this.#moveRows(fromRows, set);

		let duplicatesRemoved = 0;
		let duplicatesKept = 0;
		if (job.collapseDuplicates) {
			// Prefers the copy that was archived from `into` itself (see #rankedDuplicates), so an
			// unmerge later never strips `into` of a message.
			const sweep = await ArchiveMaintenanceService.cleanupDuplicates(
				actor,
				job.actorIp,
				rootSourceId,
				into
			);
			duplicatesRemoved = sweep.removed;
			duplicatesKept =
				sweep.skippedProtected + sweep.skippedContentDiffers + sweep.skippedFailed;
		}

		return { moved, duplicatesRemoved, duplicatesKept };
	}

	/** The body of the `unmerge-mailbox` job. Returns how many rows moved back. */
	static async runUnmerge(job: IUnmergeMailboxJob): Promise<number> {
		const { rootSourceId, mailbox } = job;
		const groupIds = await IngestionService.findGroupSourceIds(rootSourceId, {
			id: rootSourceId,
			mergedIntoId: null,
		});
		const mergedRows = and(
			IngestionService.groupScopeFilter(groupIds),
			eq(archivedEmails.originalUserEmail, mailbox)
		);
		const set = { userEmail: mailbox, originalUserEmail: null };

		let moved = await this.#moveRows(mergedRows, set);
		// Same reason as the merge's final pass: a running sync may still hold the alias for
		// up to its memo lifetime and write a few more rows under the old canonical mailbox.
		await sleep(SETTLE_DELAY_MS);
		moved += await this.#moveRows(mergedRows, set);
		return moved;
	}

	/**
	 * Rewrites matching rows in batches until none are left, and queues each batch for indexing.
	 *
	 * `where` must stop matching a row once it is rewritten, which is what lets every batch be read
	 * from the top without a cursor. The rows are marked unindexed in the same statement, so a
	 * failed enqueue is still picked up by the reconcile job rather than leaving the search index
	 * reporting the old mailbox for good.
	 */
	static async #moveRows(
		where: ReturnType<typeof and>,
		set: { userEmail: string; originalUserEmail: ReturnType<typeof sql> | null }
	): Promise<number> {
		let moved = 0;
		for (;;) {
			const batch = db
				.select({ id: archivedEmails.id })
				.from(archivedEmails)
				.where(where)
				.limit(MOVE_BATCH_SIZE);
			const rows = await db
				.update(archivedEmails)
				.set({ ...set, isIndexed: false, indexAttempts: 0 })
				.where(inArray(archivedEmails.id, batch))
				.returning({ id: archivedEmails.id });
			if (rows.length === 0) {
				return moved;
			}
			moved += rows.length;
			try {
				await indexingQueue.add('index-email-batch', {
					emails: rows.map((row) => ({ archivedEmailId: row.id })),
				});
			} catch (error) {
				logger.warn(
					{ err: error, count: rows.length },
					'Could not queue moved emails for indexing; the reconcile job will pick them up'
				);
			}
		}
	}
}
