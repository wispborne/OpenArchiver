import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ArchiveClient, type ClientOptions } from './client.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { registerArchiveTools } from './tools/archive.js';
import { registerEmailTools } from './tools/email.js';
import { registerSearch } from './tools/search.js';
import type { ToolContext } from './tools/context.js';

export const SERVER_VERSION = '0.1.0';

/** One MCP server bound to one API key: a stdio process, or a single HTTP request. */
export function createArchiveServer(options: ClientOptions): McpServer {
	const server = new McpServer(
		{ name: 'open-archiver', title: 'Open Archiver', version: SERVER_VERSION },
		{ instructions: SERVER_INSTRUCTIONS }
	);
	const context: ToolContext = {
		client: new ArchiveClient(options),
		cacheKey: createHash('sha256').update(options.apiKey).digest('hex'),
	};
	registerSearch(server, context);
	registerEmailTools(server, context);
	registerArchiveTools(server, context);
	return server;
}
