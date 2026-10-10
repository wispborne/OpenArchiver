import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createArchiveServer } from './server.js';

/**
 * stdio transport, for clients that start the server themselves (Claude Code, Claude Desktop,
 * Cursor). Configuration comes from the environment the client passes in. stdout carries the
 * protocol, so everything human-readable goes to stderr.
 */
export async function startStdio(): Promise<void> {
	const missing = ['OPEN_ARCHIVER_URL', 'OPEN_ARCHIVER_API_KEY'].filter(
		(name) => !process.env[name]
	);
	if (missing.length > 0) {
		console.error(
			`open-archiver-mcp: set ${missing.join(' and ')}. ` +
				'OPEN_ARCHIVER_URL is the address you open Open Archiver at (e.g. http://localhost:3000); ' +
				'OPEN_ARCHIVER_API_KEY is an API key created under Settings → API Keys.'
		);
		process.exit(1);
	}

	const server = createArchiveServer({
		baseUrl: process.env.OPEN_ARCHIVER_URL!,
		apiKey: process.env.OPEN_ARCHIVER_API_KEY!,
	});
	await server.connect(new StdioServerTransport());
	console.error(`open-archiver-mcp: serving ${process.env.OPEN_ARCHIVER_URL} over stdio`);
}
