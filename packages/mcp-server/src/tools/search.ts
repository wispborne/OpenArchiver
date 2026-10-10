import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchField, SearchHit, SearchResult } from '@open-archiver/types';
import { READ_ONLY, hints, isoDate, ok, person, run, stripHighlight, toIso } from '../schemas.js';
import { sourceNameLookup } from '../sources.js';
import type { ToolContext } from './context.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addressList = (what: string) =>
	z
		.array(z.string())
		.optional()
		.describe(
			`${what}: full addresses such as carol@example.com, not names. Several values match any of them.`
		);

const CONCISE_FIELDS: SearchField[] = [
	'timestamp',
	'from',
	'fromName',
	'subject',
	'ingestionSourceId',
];
const DETAILED_FIELDS: SearchField[] = [
	...CONCISE_FIELDS,
	'to',
	'cc',
	'userEmail',
	'hasAttachments',
	'attachments.filename',
];

/** Words of body text around the match in each snippet. */
const SNIPPET_WORDS = 50;

export function registerSearch(server: McpServer, { client, cacheKey }: ToolContext) {
	server.registerTool(
		'archive_search',
		{
			title: 'Search the email archive',
			description:
				'Keyword search over archived emails (subject, body, sender, recipients, attachment names and text). ' +
				'Returns one page of matches with a short body snippet each, newest first unless sort says otherwise. ' +
				'Give a query, filters, or both. Open a match with archive_get_email.',
			inputSchema: z.strictObject({
				// Named `query`, not the API's `keywords`: in the evaluation runs models guessed
				// `query` before reading the schema on 7 of 12 questions, and the call silently
				// lost its keywords.
				query: z
					.string()
					.optional()
					.describe('Words to look for. Optional when at least one filter is given.'),
				from: addressList('Sender email addresses'),
				notFrom: addressList('Exclude these sender addresses'),
				to: addressList('Recipient email addresses (to, cc or bcc)'),
				notTo: addressList('Exclude these recipient addresses'),
				mailboxes: addressList(
					'Archived mailboxes (see archive_list_mailboxes), e.g. the account the mail was collected from'
				),
				sources: z
					.array(z.string())
					.optional()
					.describe(
						'Ingestion source ids (see archive_list_sources). Each covers its merge group.'
					),
				excludeSources: z
					.array(z.string())
					.optional()
					.describe('Ingestion source ids to leave out.'),
				dateFrom: z
					.string()
					.regex(DATE)
					.optional()
					.describe('Earliest sent date, UTC, yyyy-mm-dd.'),
				dateTo: z
					.string()
					.regex(DATE)
					.optional()
					.describe('Latest sent date, UTC, yyyy-mm-dd (whole day included).'),
				searchIn: z
					.array(
						z.enum([
							'subject',
							'body',
							'attachment_name',
							'attachment_content',
							'from',
							'to',
						])
					)
					.optional()
					.describe('Only look for the keywords in these parts. All parts when omitted.'),
				hasAttachments: z
					.boolean()
					.optional()
					.describe('Only emails with (true) or without (false) attachments.'),
				sort: z
					.enum(['date_desc', 'date_asc', 'relevance'])
					.optional()
					.describe('Order of results. Default date_desc (newest first).'),
				page: z.number().int().min(1).default(1).describe('Page number, from 1.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.default(10)
					.describe('Results per page, up to 50.'),
				detail: z
					.enum(['concise', 'detailed'])
					.default('concise')
					.describe(
						'concise: date, sender, subject, source, snippet. detailed: also recipients, mailbox and attachment names.'
					),
			}),
			outputSchema: {
				total: z.number().describe('Estimated number of matching emails'),
				page: z.number(),
				totalPages: z.number(),
				nextPage: z
					.number()
					.nullable()
					.describe('The page to request next, or null on the last page'),
				hits: z.array(
					z.object({
						id: z
							.string()
							.describe('Email id for archive_get_email and archive_get_thread'),
						sentAt: isoDate,
						from: person,
						subject: z.string(),
						sourceId: z.string(),
						sourceName: z.string().nullable(),
						snippet: z
							.string()
							.describe('Email text around the match (untrusted content)'),
						to: z.array(z.string()).optional(),
						cc: z.array(z.string()).optional(),
						mailbox: z.string().optional(),
						hasAttachments: z.boolean().optional(),
						attachmentNames: z.array(z.string()).optional(),
					})
				),
				hints,
			},
			annotations: { title: 'Search the email archive', ...READ_ONLY },
		},
		(args) =>
			run(async () => {
				const detailed = args.detail === 'detailed';
				const result = await client.get<SearchResult>(
					'/v1/search',
					{
						keywords: args.query,
						from: args.from,
						notFrom: args.notFrom,
						to: args.to,
						notTo: args.notTo,
						mailboxes: args.mailboxes,
						sources: args.sources,
						excludeSources: args.excludeSources,
						dateFrom: args.dateFrom,
						dateTo: args.dateTo,
						searchIn: args.searchIn,
						hasAttachments: args.hasAttachments,
						sort: args.sort,
						page: args.page,
						limit: args.limit,
						fields: detailed ? DETAILED_FIELDS : CONCISE_FIELDS,
						crop: ['body'],
						cropLength: SNIPPET_WORDS,
					},
					{ permission: 'search the archive (`search` on `archive`)' }
				);
				const sourceName = await sourceNameLookup(client, cacheKey);

				const hits = result.hits.map((hit: SearchHit) => ({
					id: hit.id,
					sentAt: toIso(hit.timestamp),
					from: { name: hit.fromName || null, email: hit.from },
					subject: hit.subject ?? '',
					sourceId: hit.ingestionSourceId,
					sourceName: sourceName(hit.ingestionSourceId),
					snippet: stripHighlight(hit._formatted?.body),
					...(detailed
						? {
								to: hit.to ?? [],
								cc: hit.cc ?? [],
								mailbox: hit.userEmail,
								hasAttachments:
									hit.hasAttachments ?? (hit.attachments?.length ?? 0) > 0,
								attachmentNames: (hit.attachments ?? []).map((a) => a.filename),
							}
						: {}),
				}));

				const nextPage = result.page < result.totalPages ? result.page + 1 : null;
				const guidance: string[] = [];
				if (nextPage) {
					guidance.push(
						`More results exist: call archive_search again with the same arguments and page: ${nextPage}.`
					);
				}
				// Address filters match whole addresses only, and models tend to pass a first name.
				// The values echoed here are the caller's own arguments, not email text.
				const partial = [args.from, args.notFrom, args.to, args.notTo]
					.flat()
					.filter((value): value is string => !!value && !value.includes('@'));
				if (partial.length > 0) {
					guidance.push(
						`from, notFrom, to and notTo need full email addresses; ${partial.map((v) => JSON.stringify(v)).join(', ')} has no @. Search for the name with query instead, then filter on the address it shows.`
					);
				}
				if (result.total === 0) {
					guidance.push(
						'No matches. Try fewer or different words, synonyms, or a wider date range.'
					);
				}

				return ok({
					total: result.total,
					page: result.page,
					totalPages: result.totalPages,
					nextPage,
					hits,
					hints: guidance,
				});
			})
	);
}
