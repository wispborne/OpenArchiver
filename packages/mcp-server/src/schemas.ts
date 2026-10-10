/**
 * Shared output shapes and the helpers that build tool results.
 *
 * Results are shaped for a model, not mirrored from the API: ISO 8601 timestamps instead of epoch
 * numbers, source names next to source ids, and paging that says what to ask for next.
 *
 * Text that comes from an archived email (subjects, bodies, snippets, sender names, attachment
 * text and names) only ever goes into its own field. Server-written guidance lives in `hints`,
 * which never interpolates email text, so an email can't dress up an instruction as one of ours.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolError } from './client.js';

/** Annotations shared by every tool: nothing here changes the archive, and it's a closed world. */
export const READ_ONLY = {
	readOnlyHint: true,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export const person = z.object({
	name: z.string().nullable(),
	email: z.string(),
});

export const hints = z
	.array(z.string())
	.describe('Guidance from the MCP server about what to call next. Never contains email text.');

export const isoDate = z.string().describe('ISO 8601 timestamp in UTC');

/** `2024-03-05T14:02:00Z`: an epoch number or any date string, in UTC, without milliseconds. */
export function toIso(value: number | string | Date): string {
	const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
	return date.toISOString().replace(/\.000Z$/, 'Z');
}

/** Meilisearch marks matches with `<em>`; the model gets plain text. */
export function stripHighlight(text: string | undefined): string {
	return (text ?? '').replace(/<\/?em>/g, '').trim();
}

/** A successful result: structured for clients that read it, JSON text for the rest. */
export function ok(data: Record<string, unknown>): CallToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(data) }],
		structuredContent: data,
	};
}

/** Runs a tool body and turns failures into readable tool errors instead of protocol errors. */
export async function run(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await body();
	} catch (error) {
		const message =
			error instanceof ToolError
				? error.message
				: `Unexpected error in the MCP server: ${error instanceof Error ? error.message : String(error)}`;
		return { isError: true, content: [{ type: 'text', text: message }] };
	}
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
