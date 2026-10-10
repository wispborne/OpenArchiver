import { setTimeout as sleep } from 'timers/promises';
import { and, asc, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type {
	IMergeMailboxesJob,
	IMergeMailboxesResult,
	IUnmergeMailboxJob,
	MailboxAlias,
	MailboxMergeBlockedReason,
	MailboxMergePreview,
	MailboxMergeProgress,
	MailboxMergeStatus,
	User,
} from '@open-archiver/types';
import type { Job } from 'bullmq';
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

/**
 * How long the outcome of the last merge or unmerge stays readable after it finishes. Long enough
 * to come back to a page the next day; the record is replaced by the group's next merge anyway.
 */
const LAST_RUN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Receives a running job's progress. The processor forwards it to BullMQ. */
export type MailboxMergeProgressReporter = (progress: MailboxMergeProgress) => Promise<void>;

/**
 * What the processor records about a run, apart from the BullMQ job.
 *
 * The job record is not enough to report on afterwards: the indexing worker trims finished jobs to
 * the most recent hundred across the whole queue, and one large import's index batches push a
 * finished merge out within seconds. This record is the group's own, so nothing else trims it.
 */
interface MailboxMergeRunRecord {
	kind: 'merge' | 'unmerge';
	state: 'running' | 'completed' | 'failed';
	mailbox: string;
	into: string | null;
	collapseDuplicates: boolean;
	result: IMergeMailboxesResult | null;
	error: string | null;
	startedAt: string;
	finishedAt: string | null;
}

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

	static #lastRunKey(rootSourceId: string): string {
		return `open-archiver:mailbox-merge:last-run:${rootSourceId}`;
	}

	/**
	 * Records the state of a run for {@link getStatus}. Written as the job starts and again as it
	 * ends, so a run that stops without reaching the end — its worker killed mid-move — is left
	 * reading `running` with no live job behind it, which is how it is recognised as interrupted.
	 *
	 * Never throws: the record only serves the status display, and failing to write it must not
	 * fail a merge that has already moved rows.
	 */
	static async recordRun(rootSourceId: string, record: MailboxMergeRunRecord): Promise<void> {
		try {
			const client = await indexingQueue.client;
			await client.set(
				this.#lastRunKey(rootSourceId),
				JSON.stringify(record),
				'EX',
				LAST_RUN_TTL_SECONDS
			);
		} catch (error) {
			logger.warn({ err: error, rootSourceId }, 'Could not record the mailbox merge status');
		}
	}

	/**
	 * The latest merge or unmerge of a source's merge group: the one queued or running, or else
	 * the last one to finish. Null when the group has none on record.
	 *
	 * The live job is preferred, then the job's own finished record while BullMQ still holds it,
	 * then the group's run record (see {@link recordRun}).
	 */
	static async getStatus(sourceId: string): Promise<MailboxMergeStatus | null> {
		const rootSourceId = await this.resolveRootId(sourceId);
		const [job, workerAlive] = await Promise.all([
			indexingQueue.getJob(this.jobIdFor(rootSourceId)),
			isIndexingWorkerAlive(),
		]);
		const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

		if (job) {
			const jobState = await job.getState();
			const kind = job.name === 'unmerge-mailbox' ? 'unmerge' : 'merge';
			const data = job.data as IMergeMailboxesJob | IUnmergeMailboxJob;
			const base = {
				kind,
				mailbox: 'from' in data ? data.from : data.mailbox,
				into: 'into' in data ? data.into : null,
				collapseDuplicates: 'collapseDuplicates' in data ? data.collapseDuplicates : false,
				queuedAt: iso(job.timestamp),
				startedAt: iso(job.processedOn),
				finishedAt: iso(job.finishedOn),
				workerAlive,
			} as const;

			if (jobState === 'completed') {
				// The unmerge job returns only `{ moved }`.
				const value = (job.returnvalue ?? {}) as Partial<IMergeMailboxesResult>;
				return {
					...base,
					state: 'completed',
					progress: null,
					result: {
						moved: value.moved ?? 0,
						duplicatesRemoved: value.duplicatesRemoved ?? 0,
						duplicatesKept: value.duplicatesKept ?? 0,
					},
					error: null,
				};
			}
			if (jobState === 'failed') {
				return {
					...base,
					state: 'failed',
					progress: null,
					result: null,
					error: job.failedReason || null,
				};
			}
			if (jobState !== 'unknown') {
				return {
					...base,
					state: jobState === 'active' ? 'running' : 'queued',
					progress: this.#readProgress(job),
					result: null,
					error: null,
				};
			}
		}

		let record: MailboxMergeRunRecord | null = null;
		try {
			const client = await indexingQueue.client;
			const raw = await client.get(this.#lastRunKey(rootSourceId));
			record = raw ? (JSON.parse(raw) as MailboxMergeRunRecord) : null;
		} catch (error) {
			logger.warn({ err: error, rootSourceId }, 'Could not read the mailbox merge status');
		}
		if (!record) {
			return null;
		}
		return {
			kind: record.kind,
			// No live job, yet the record never reached its end: the run was cut off.
			state: record.state === 'running' ? 'interrupted' : record.state,
			mailbox: record.mailbox,
			into: record.into,
			collapseDuplicates: record.collapseDuplicates,
			progress: null,
			result: record.result,
			error: record.error,
			queuedAt: null,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			workerAlive,
		};
	}

	/** BullMQ stores progress as whatever was last reported; anything but our shape is ignored. */
	static #readProgress(job: Job): MailboxMergeProgress | null {
		const progress = job.progress as Partial<MailboxMergeProgress> | number | undefined;
		if (!progress || typeof progress !== 'object' || typeof progress.moved !== 'number') {
			return null;
		}
		return progress as MailboxMergeProgress;
	}

	/** How many rows match, for a progress total. */
	static async #countRows(where: ReturnType<typeof and>): Promise<number> {
		const [row] = await db.select({ count: count() }).from(archivedEmails).where(where);
		return row?.count ?? 0;
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
	static async runMerge(
		job: IMergeMailboxesJob,
		actor: User,
		report: MailboxMergeProgressReporter = async () => {}
	): Promise<IMergeMailboxesResult> {
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

		const moved = await this.#moveInTwoPasses(fromRows, set, report);

		let duplicatesRemoved = 0;
		let duplicatesKept = 0;
		if (job.collapseDuplicates) {
			await report({ phase: 'removing_duplicates', moved, total: moved });
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
	static async runUnmerge(
		job: IUnmergeMailboxJob,
		report: MailboxMergeProgressReporter = async () => {}
	): Promise<number> {
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

		return this.#moveInTwoPasses(mergedRows, set, report);
	}

	/**
	 * Moves the rows, waits out the alias memo, and moves whatever arrived meanwhile.
	 *
	 * The wait is the same for both directions. A sync that started before the alias changed may
	 * keep writing under the old mailbox until its alias memo expires (MAILBOX_ALIAS_CACHE_MS), so
	 * the second pass is what catches those rows. It is also why every run takes at least about a
	 * minute, which the progress report says, so a page showing it does not look stuck.
	 */
	static async #moveInTwoPasses(
		where: ReturnType<typeof and>,
		set: { userEmail: string; originalUserEmail: ReturnType<typeof sql> | null },
		report: MailboxMergeProgressReporter
	): Promise<number> {
		let total = await this.#countRows(where);
		await report({ phase: 'moving', moved: 0, total });
		const first = await this.#moveRows(where, set, (moved) =>
			report({ phase: 'moving', moved, total: Math.max(total, moved) })
		);
		total = Math.max(total, first);

		const settleUntil = new Date(Date.now() + SETTLE_DELAY_MS).toISOString();
		await report({ phase: 'settling', moved: first, total, settleUntil });
		await sleep(SETTLE_DELAY_MS);

		const late = await this.#countRows(where);
		total += late;
		await report({ phase: 'final_pass', moved: first, total });
		const second = await this.#moveRows(where, set, (moved) =>
			report({
				phase: 'final_pass',
				moved: first + moved,
				total: Math.max(total, first + moved),
			})
		);
		return first + second;
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
		set: { userEmail: string; originalUserEmail: ReturnType<typeof sql> | null },
		onBatch: (movedSoFar: number) => Promise<void> = async () => {}
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
			await onBatch(moved);
		}
	}
}
