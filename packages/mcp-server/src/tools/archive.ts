import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DashboardStats, IngestionStats } from '@open-archiver/types';
import { READ_ONLY, hints, isoDate, ok, run, toIso } from '../schemas.js';
import { listSources } from '../sources.js';
import type { ToolContext } from './context.js';

const SOURCE_PERMISSION = 'read ingestion sources (`read` on `ingestion`)';

const iso = (value: Date | string | null | undefined) => (value ? toIso(value) : null);

export function registerArchiveTools(server: McpServer, { client, cacheKey }: ToolContext) {
	server.registerTool(
		'archive_list_sources',
		{
			title: 'List archive sources',
			description:
				'Lists the ingestion sources the archive collects mail from (mail servers, imports), with their status. ' +
				'Use a source id to filter archive_search or with archive_get_source_stats.',
			inputSchema: z.strictObject({}),
			outputSchema: {
				sources: z.array(
					z.object({
						id: z.string(),
						name: z.string(),
						provider: z.string(),
						status: z.string(),
						mergedInto: z
							.object({ id: z.string(), name: z.string().nullable() })
							.nullable()
							.describe(
								'The root source this one was merged into; its mail is searched under the root'
							),
						lastSyncFinishedAt: isoDate.nullable(),
					})
				),
				hints,
			},
			annotations: { title: 'List archive sources', ...READ_ONLY },
		},
		() =>
			run(async () => {
				const sources = await listSources(client, cacheKey, { fresh: true });
				return ok({
					sources: [...sources.values()].map((source) => ({
						id: source.id,
						name: source.name,
						provider: source.provider,
						status: source.status,
						mergedInto: source.mergedIntoId
							? {
									id: source.mergedIntoId,
									name: sources.get(source.mergedIntoId)?.name ?? null,
								}
							: null,
						lastSyncFinishedAt: iso(source.lastSyncFinishedAt),
					})),
					hints: [],
				});
			})
	);

	server.registerTool(
		'archive_get_source_stats',
		{
			title: 'Get source statistics',
			description:
				'Statistics for one ingestion source: email and thread counts, storage, index coverage, date range, last sync, and mail per mailbox. ' +
				'For a merge root the numbers cover the whole group.',
			inputSchema: z.strictObject({
				sourceId: z.string().describe('Source id from archive_list_sources'),
			}),
			outputSchema: {
				sourceId: z.string(),
				name: z.string(),
				provider: z.string(),
				status: z.string(),
				totalEmails: z.number(),
				threadCount: z.number(),
				mailboxCount: z.number(),
				totalBytes: z.number(),
				attachmentCount: z.number(),
				indexedCount: z.number().describe('Emails searchable now'),
				legalHoldCount: z.number(),
				firstEmailAt: isoDate.nullable(),
				lastEmailAt: isoDate.nullable(),
				lastSyncFinishedAt: isoDate.nullable(),
				lastSyncStatusMessage: z.string().nullable(),
				mailboxes: z.array(z.object({ mailbox: z.string(), emailCount: z.number() })),
				mergedSources: z
					.array(z.object({ id: z.string(), name: z.string() }))
					.describe('Sources merged into this one'),
				hints,
			},
			annotations: { title: 'Get source statistics', ...READ_ONLY },
		},
		({ sourceId }) =>
			run(async () => {
				const stats = await client.get<IngestionStats>(
					`/v1/ingestion-sources/${encodeURIComponent(sourceId)}/stats`,
					{},
					{ permission: SOURCE_PERMISSION }
				);
				return ok({
					sourceId: stats.sourceId,
					name: stats.name,
					provider: stats.provider,
					status: stats.status,
					totalEmails: stats.totalEmails,
					threadCount: stats.threadCount,
					mailboxCount: stats.mailboxCount,
					totalBytes: stats.totalBytes,
					attachmentCount: stats.attachmentCount,
					indexedCount: stats.indexedCount,
					legalHoldCount: stats.legalHoldCount,
					firstEmailAt: iso(stats.firstEmailAt),
					lastEmailAt: iso(stats.lastEmailAt),
					lastSyncFinishedAt: iso(stats.lastSyncFinishedAt),
					lastSyncStatusMessage: stats.lastSyncStatusMessage ?? null,
					mailboxes: stats.mailboxes.map((m) => ({
						mailbox: m.userEmail,
						emailCount: m.emailCount,
					})),
					mergedSources: stats.children.map((c) => ({ id: c.id, name: c.name })),
					hints:
						stats.indexedCount < stats.totalEmails
							? [
									`${stats.totalEmails - stats.indexedCount} emails are not indexed yet and won't appear in archive_search.`,
								]
							: [],
				});
			})
	);

	server.registerTool(
		'archive_list_mailboxes',
		{
			title: 'List archived mailboxes',
			description:
				'Lists archived mailboxes (the accounts mail was collected from), most common first, for the mailboxes filter of archive_search. ' +
				'Not every mailbox is an email address: IMAP logins and import names appear as they were collected.',
			inputSchema: z.strictObject({
				prefix: z
					.string()
					.optional()
					.describe(
						'Only mailboxes matching this text, e.g. the start of an address or a domain'
					),
			}),
			outputSchema: {
				mailboxes: z.array(z.string()),
				hints,
			},
			annotations: { title: 'List archived mailboxes', ...READ_ONLY },
		},
		({ prefix }) =>
			run(async () => {
				const facets = await client.get<{ values: string[] }>(
					'/v1/search/facets',
					{ field: 'mailboxes', query: prefix ?? '' },
					{ permission: 'search the archive (`search` on `archive`)' }
				);
				return ok({
					mailboxes: facets.values,
					hints:
						facets.values.length === 0
							? ['No mailboxes match. Try a shorter prefix, or none.']
							: [],
				});
			})
	);

	server.registerTool(
		'archive_overview',
		{
			title: 'Archive overview',
			description:
				'Totals for the whole archive: emails archived, storage used, and failed ingestions in the last 7 days.',
			inputSchema: z.strictObject({}),
			outputSchema: {
				totalEmailsArchived: z.number(),
				totalStorageBytes: z.number(),
				failedIngestionsLast7Days: z.number(),
				hints,
			},
			annotations: { title: 'Archive overview', ...READ_ONLY },
		},
		() =>
			run(async () => {
				const stats = await client.get<DashboardStats>(
					'/v1/dashboard/stats',
					{},
					{ permission: 'read the dashboard (`read` on `dashboard`)' }
				);
				return ok({
					totalEmailsArchived: stats.totalEmailsArchived,
					// The API sends this as a string despite its type (a Postgres bigint sum).
					totalStorageBytes: Number(stats.totalStorageUsed),
					failedIngestionsLast7Days: stats.failedIngestionsLast7Days,
					hints: [],
				});
			})
	);
}
