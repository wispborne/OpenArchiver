import { createHash, randomUUID } from 'crypto';
import { asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import type { Job } from 'bullmq';
import type {
	AttachmentRepairProgress,
	AttachmentRepairStatus,
	IAttachmentRepairResult,
} from '@open-archiver/types';
import { db } from '../database';
import { archivedEmails, attachments, emailAttachments } from '../database/schema';
import { StorageService } from './StorageService';
import { IngestionService } from './IngestionService';
import { indexingQueue } from '../jobs/queues';
import { claimJobId } from '../jobs/helpers/claimJobId';
import { isIndexingWorkerAlive } from '../jobs/helpers/workerLiveness';
import { mapWithConcurrency } from '../helpers/mapWithConcurrency';
import { streamToBuffer } from '../helpers/streamToBuffer';
import { config } from '../config';
import { logger } from '../config/logger';

/** The one job id a repair runs under, so two can never overlap. */
const JOB_ID = 'repair-attachments';
/** Attachment records read per page. */
const PAGE_SIZE = 500;
/** Storage lookups in flight at once. Each is one stat, or a read and parse for a repair. */
const CONCURRENCY = 8;
/** Linked emails tried, in turn, as the source of a missing attachment. */
const MAX_SOURCE_EMAILS = 3;
/** Repairs and refusals written to the job log one by one before it only counts them. */
const MAX_LOGGED_ITEMS = 50;
const RECORD_KEY = 'open-archiver:attachment-repair:last-run';
const RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

interface RunRecord {
	state: 'running' | 'completed' | 'failed';
	result: IAttachmentRepairResult | null;
	error: string | null;
	startedAt: string;
	finishedAt: string | null;
}

/**
 * Restores attachment files that are recorded in the database but missing from storage.
 *
 * Older versions shared one attachment record between ingestion sources, and stored it in the
 * folder of whichever source saw it first. Deleting that source removed its folder, files and all,
 * but kept the records its successors still linked to, with no source of their own to cascade from.
 * Those emails then had attachments that could not be downloaded or indexed: "File not found".
 *
 * A file can be rebuilt only where an email's stored .eml still holds the attachment. Ingestion
 * normally strips attachments out of the .eml and keeps them only as these files, so for most mail
 * the file is the only copy and cannot be rebuilt from the archive; the .eml is whole for sources in
 * preserve-original mode, and for mail archived by versions that did not strip. A file is rebuilt
 * only from an attachment whose SHA-256 equals the recorded checksum, so the integrity report still
 * verifies it, and it is written in the current layout under the email's source. Nothing is ever
 * deleted: a record that cannot be repaired is left as it is, and reported with the emails it
 * affects, so the operator knows what to restore from a backup or the original mailbox.
 *
 * The same walk gives old records that have no source the source of an email that uses them.
 * Ingestion reuses an attachment record only within its own source, so until then new mail stored
 * fresh copies of attachments the archive already had, and the source's statistics left them out.
 * A record whose file is missing is only given a source once it has been repaired, so ingestion
 * never starts reusing a record that has no file behind it.
 */
export class AttachmentRepairService {
	static async trigger(
		actorId: string
	): Promise<{ alreadyRunning: boolean; workerAlive: boolean }> {
		const alreadyRunning = await claimJobId(indexingQueue, JOB_ID);
		if (!alreadyRunning) {
			// attempts: 1 like the other maintenance jobs. Re-running is safe — each pass finds
			// only what is still missing — so a failed run is repeated by asking again.
			await indexingQueue.add(
				'repair-attachments',
				{ actorId },
				{ jobId: JOB_ID, attempts: 1 }
			);
		}
		return { alreadyRunning, workerAlive: await isIndexingWorkerAlive() };
	}

	/** The repair in progress, or the last one to finish; null when none is on record. */
	static async getStatus(): Promise<AttachmentRepairStatus | null> {
		const [job, workerAlive] = await Promise.all([
			indexingQueue.getJob(JOB_ID),
			isIndexingWorkerAlive(),
		]);
		const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

		if (job) {
			const state = await job.getState();
			const base = {
				startedAt: iso(job.processedOn),
				finishedAt: iso(job.finishedOn),
				workerAlive,
			};
			if (state === 'completed') {
				return {
					...base,
					state: 'completed',
					progress: null,
					result: job.returnvalue as IAttachmentRepairResult,
					error: null,
				};
			}
			if (state === 'failed') {
				return {
					...base,
					state: 'failed',
					progress: null,
					result: null,
					error: job.failedReason || null,
				};
			}
			if (state !== 'unknown') {
				const progress = job.progress as AttachmentRepairProgress | number | undefined;
				return {
					...base,
					state: state === 'active' ? 'running' : 'queued',
					progress: progress && typeof progress === 'object' ? progress : null,
					result: null,
					error: null,
				};
			}
		}

		// The job record itself is trimmed within seconds on a busy indexing queue, so the outcome
		// is also kept here. A record still saying "running" with no live job was cut off.
		let record: RunRecord | null = null;
		try {
			const client = await indexingQueue.client;
			const raw = await client.get(RECORD_KEY);
			record = raw ? (JSON.parse(raw) as RunRecord) : null;
		} catch (error) {
			logger.warn({ err: error }, 'Could not read the attachment repair status');
		}
		if (!record) {
			return null;
		}
		return {
			state: record.state === 'running' ? 'interrupted' : record.state,
			progress: null,
			result: record.result,
			error: record.error,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			workerAlive,
		};
	}

	static async recordRun(record: RunRecord): Promise<void> {
		try {
			const client = await indexingQueue.client;
			await client.set(RECORD_KEY, JSON.stringify(record), 'EX', RECORD_TTL_SECONDS);
		} catch (error) {
			logger.warn({ err: error }, 'Could not record the attachment repair status');
		}
	}

	/** The body of the `repair-attachments` job. */
	static async run(job: Job): Promise<IAttachmentRepairResult> {
		const storage = new StorageService();
		const result: IAttachmentRepairResult = {
			checked: 0,
			missing: 0,
			repaired: 0,
			unreferenced: 0,
			notFoundInEmail: 0,
			failed: 0,
			ownerBackfilled: 0,
			emailsReindexed: 0,
			emailsAffected: 0,
		};
		const toReindex = new Set<string>();
		const affected = new Set<string>();
		let logged = 0;
		const log = async (line: string) => {
			if (logged >= MAX_LOGGED_ITEMS) return;
			logged++;
			await job.log(
				logged === MAX_LOGGED_ITEMS ? `${line} (further items are only counted)` : line
			);
		};

		const [{ total }] = await db
			.select({ total: sql<number>`count(*)::int` })
			.from(attachments);
		const report = async (phase: AttachmentRepairProgress['phase']) => {
			await job
				.updateProgress({
					phase,
					done: result.checked,
					total,
					repaired: result.repaired,
					missing: result.missing,
				})
				.catch(() => undefined);
		};
		await job.log(`Checking ${total} attachment records.`);
		await report('checking');

		let cursor: string | null = null;
		for (;;) {
			const page: (typeof attachments.$inferSelect)[] = await db
				.select()
				.from(attachments)
				.where(cursor ? gt(attachments.id, cursor) : undefined)
				.orderBy(asc(attachments.id))
				.limit(PAGE_SIZE);
			if (page.length === 0) break;
			cursor = page[page.length - 1].id;

			await mapWithConcurrency(page, CONCURRENCY, async (row) => {
				try {
					const present = await storage.exists(row.storagePath);
					if (present) {
						if (!row.ingestionSourceId && (await this.#backfillOwner(row.id))) {
							result.ownerBackfilled++;
						}
						return;
					}
					result.missing++;
					const outcome = await this.#repair(row, storage);
					if (outcome.kind === 'repaired') {
						result.repaired++;
						for (const id of outcome.emailIds) toReindex.add(id);
						await log(`Restored "${row.filename}" to ${outcome.path}`);
					} else if (outcome.kind === 'unreferenced') {
						result.unreferenced++;
						await log(
							`No email uses "${row.filename}" (${row.storagePath}); left as is.`
						);
					} else {
						result.notFoundInEmail++;
						for (const id of outcome.emailIds) affected.add(id);
						await log(
							`"${row.filename}" (${row.storagePath}) could not be rebuilt: none of its emails' stored files holds it. Left as is.`
						);
					}
				} catch (error) {
					result.failed++;
					const message = error instanceof Error ? error.message : String(error);
					logger.warn({ err: error, attachmentId: row.id }, 'Attachment repair failed');
					await log(`Failed on "${row.filename}" (${row.storagePath}): ${message}`);
				} finally {
					result.checked++;
				}
			});
			await report('checking');
		}

		result.emailsAffected = affected.size;
		if (affected.size > 0) {
			await job.log(
				`Emails using an attachment that is missing and could not be rebuilt: ${affected.size}.`
			);
		}
		await job.log(
			`Checked ${result.checked}: ${result.missing} missing, ${result.repaired} restored, ${result.ownerBackfilled} given a source.`
		);

		// The restored attachments were left out of these emails' search documents, so they are
		// rebuilt. Marked first, so the reconcile job catches any batch that fails to queue.
		if (toReindex.size > 0) {
			await report('reindexing');
			const ids = [...toReindex];
			for (let i = 0; i < ids.length; i += config.meili.indexingBatchSize) {
				const batch = ids.slice(i, i + config.meili.indexingBatchSize);
				await db
					.update(archivedEmails)
					.set({ isIndexed: false, indexAttempts: 0 })
					.where(inArray(archivedEmails.id, batch));
				await indexingQueue.add('index-email-batch', {
					emails: batch.map((archivedEmailId) => ({ archivedEmailId })),
				});
			}
			result.emailsReindexed = ids.length;
			await job.log(`Emails queued for reindexing: ${ids.length}.`);
		}

		return result;
	}

	/** Gives a source-less record the source of the earliest email that uses it. */
	static async #backfillOwner(attachmentId: string): Promise<boolean> {
		const [owner] = await db
			.select({ sourceId: archivedEmails.ingestionSourceId })
			.from(emailAttachments)
			.innerJoin(archivedEmails, eq(archivedEmails.id, emailAttachments.emailId))
			.where(eq(emailAttachments.attachmentId, attachmentId))
			.orderBy(asc(archivedEmails.archivedAt))
			.limit(1);
		if (!owner) return false;
		await db
			.update(attachments)
			.set({ ingestionSourceId: owner.sourceId })
			.where(eq(attachments.id, attachmentId));
		return true;
	}

	static async #repair(
		row: typeof attachments.$inferSelect,
		storage: StorageService
	): Promise<
		| { kind: 'repaired'; path: string; emailIds: string[] }
		| { kind: 'unreferenced' }
		| { kind: 'not_found'; emailIds: string[] }
	> {
		const linked = await db
			.select({
				id: archivedEmails.id,
				storagePath: archivedEmails.storagePath,
				sourceId: archivedEmails.ingestionSourceId,
			})
			.from(emailAttachments)
			.innerJoin(archivedEmails, eq(archivedEmails.id, emailAttachments.emailId))
			.where(eq(emailAttachments.attachmentId, row.id))
			.orderBy(asc(archivedEmails.archivedAt));
		if (linked.length === 0) {
			return { kind: 'unreferenced' };
		}

		for (const email of linked.slice(0, MAX_SOURCE_EMAILS)) {
			let eml: Buffer;
			try {
				eml = await streamToBuffer(await storage.get(email.storagePath));
			} catch {
				// This email's own file is missing too; try the next one.
				continue;
			}
			const parsed = await simpleParser(eml);
			const match = parsed.attachments.find(
				(a) =>
					createHash('sha256').update(a.content).digest('hex') === row.contentHashSha256
			);
			if (!match) continue;

			// Ingestion's layout, under the source of the email it came from.
			const sourceId = row.ingestionSourceId ?? email.sourceId;
			const path = `${config.storage.openArchiverFolderName}/${sourceId}/attachments/${randomUUID().slice(0, 7)}-${IngestionService.buildAttachmentFileName(row.filename)}`;
			await storage.put(path, match.content);
			await db
				.update(attachments)
				.set({ storagePath: path, ingestionSourceId: sourceId })
				.where(eq(attachments.id, row.id));
			return { kind: 'repaired', path, emailIds: linked.map((e) => e.id) };
		}
		return { kind: 'not_found', emailIds: linked.map((e) => e.id) };
	}
}
