import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createArchiveServer } from './server.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Streamable HTTP transport, for clients that connect over the network (Open WebUI in the same
 * Docker network, say).
 *
 * Stateless: every request builds its own server around the API key in that request's
 * `Authorization: Bearer` header, so the MCP server holds no key of its own and no session state.
 *
 * Meant for localhost or a private Docker network only. Two protections assume that:
 * - Host header validation on every request (DNS-rebinding protection), against
 *   `MCP_ALLOWED_HOSTS` or the localhost names.
 * - The client's IP is forwarded to the API as `X-Forwarded-For`, so the API's per-IP rate
 *   limit counts each client separately. With `MCP_TRUST_PROXY=true` an incoming
 *   `X-Forwarded-For` is honoured instead, for when this server itself sits behind a proxy.
 */
export async function startHttp(): Promise<void> {
	const baseUrl = process.env.OPEN_ARCHIVER_URL;
	if (!baseUrl) {
		console.error(
			'open-archiver-mcp: set OPEN_ARCHIVER_URL, the address of Open Archiver as seen from this server (e.g. http://open-archiver:3000).'
		);
		process.exit(1);
	}
	const host = process.env.MCP_HOST || '127.0.0.1';
	const port = Number(process.env.MCP_PORT || 3333);
	const allowedHosts = process.env.MCP_ALLOWED_HOSTS
		? process.env.MCP_ALLOWED_HOSTS.split(',')
				.map((h) => h.trim())
				.filter(Boolean)
		: LOCAL_HOSTS;

	// `createMcpExpressApp` only validates the Host header by itself when bound to a localhost
	// name, so the check is added explicitly to cover 0.0.0.0 inside a container too.
	const app = createMcpExpressApp({ host, allowedHosts });
	app.use(hostHeaderValidation(allowedHosts));
	if (process.env.MCP_TRUST_PROXY === 'true') {
		app.set('trust proxy', true);
	}

	app.post('/mcp', async (req: Request, res: Response) => {
		const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
		if (!match) {
			res.status(401)
				.set('WWW-Authenticate', 'Bearer')
				.json({
					jsonrpc: '2.0',
					error: {
						code: -32001,
						message:
							'Send an Open Archiver API key as "Authorization: Bearer <key>". Keys are created under Settings → API Keys.',
					},
					id: null,
				});
			return;
		}

		const server = createArchiveServer({
			baseUrl,
			apiKey: match[1],
			forwardedFor: req.ip ?? req.socket.remoteAddress,
		});
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on('close', () => {
			void transport.close();
			void server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (error) {
			console.error('open-archiver-mcp: request failed', error);
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: '2.0',
					error: { code: -32603, message: 'Internal server error' },
					id: null,
				});
			}
		}
	});

	// Stateless mode has no sessions to stream to or end.
	const methodNotAllowed = (_req: Request, res: Response) => {
		res.status(405)
			.set('Allow', 'POST')
			.json({
				jsonrpc: '2.0',
				error: { code: -32000, message: 'Method not allowed.' },
				id: null,
			});
	};
	app.get('/mcp', methodNotAllowed);
	app.delete('/mcp', methodNotAllowed);

	app.listen(port, host, () => {
		console.error(
			`open-archiver-mcp: serving ${baseUrl} at http://${host}:${port}/mcp (allowed hosts: ${allowedHosts.join(', ')})`
		);
	});
}
