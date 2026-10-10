## Why

The fork's third goal is to let AI clients (Claude Code, Claude Desktop, Cursor, Open WebUI) search and read the archive. Today the REST API can't serve that well: `GET /v1/archived-emails/{id}` returns the email as a serialized Node `Buffer` (about 4× its size, unparsed MIME), and every `/v1/search` hit carries the whole body and all attachment text twice (the document plus a fully highlighted `_formatted` copy). An MCP server built on the API as it stands would download megabytes per call and still have to parse MIME itself.

## What Changes

- **New endpoint** `GET /v1/archived-emails/{id}/content`: returns the email parsed on the server (headers, plain text, optional HTML, attachment list with optional extracted text, thread siblings, a `truncated` flag), with an optional `maxChars`. It applies the same row-level permission check and writes the same `READ` audit entry as the existing endpoint.
- **New optional parameters on `GET /v1/search`**: `fields` (which document attributes to return), `crop` and `cropLength` (Meilisearch match-centred crops). When either is used, highlighting is limited to those attributes. Omitting them gives exactly today's response.
- **New workspace package `packages/mcp-server`**: a read-only MCP server using `@modelcontextprotocol/sdk`. It talks only to the REST API with the caller's API key. Eight tools, all prefixed `archive_` so they can't be confused with a live mailbox server's tools: `archive_search`, `archive_get_email`, `archive_get_thread`, `archive_get_attachment_text`, `archive_list_sources`, `archive_get_source_stats`, `archive_list_mailboxes`, `archive_overview`. Server-level instructions, structured output, readable timestamps and source names, paging hints and actionable errors, following current MCP and agent-tool practice. Email content is treated as untrusted and kept in its own fields. Two transports from one entry point: stdio, and Streamable HTTP bound to localhost / the Docker network.
- **New Docker image** `ghcr.io/wispborne/open-archiver-mcp`, built by a new fork-only workflow; runs either transport.
- **Docs**: a user guide for setting up a read-only role, an API key and the client config, with a prompt-injection warning; README "Differences from upstream" and the `CLAUDE.md` MCP section updated.
- No breaking changes. No write, sync, merge, job or delete tools. No npm package, no public HTTP setup, no OAuth (claude.ai web/mobile aren't targets).

## Capabilities

### New Capabilities

- `email-content-api`: the `GET /v1/archived-emails/{id}/content` endpoint: parsed body, attachments with optional text, thread, truncation, permissions and auditing.
- `search-result-shaping`: optional `fields`, `crop` and `cropLength` on `GET /v1/search`, and the guarantee that omitting them leaves the response unchanged.
- `mcp-server`: the MCP server's tools, their names, annotations, inputs and outputs, server instructions, error reporting, handling of untrusted email content, both transports, how the API key is supplied, the evaluation set, and how it is packaged and run.

### Modified Capabilities

None. `openspec/specs/` is empty; this is the first change recorded in OpenSpec.

## Impact

- **Backend**: `api/routes/archived-email.routes.ts`, `api/controllers/archived-email.controller.ts`, `services/ArchivedEmailService.ts` (share the permission/audit/thread path between the two read endpoints), `api/controllers/search.controller.ts`, `services/SearchService.ts`, `locales/en/translation.json`.
- **Types**: new `ArchivedEmailContent` in `packages/types/src/archived-emails.types.ts`; `SearchQuery` gains optional `fields`, `crop`, `cropLength`.
- **API spec**: regenerated `docs/api/openapi.json` (one new path, new parameters on `/v1/search`).
- **New package**: `packages/mcp-server` (dependencies `@modelcontextprotocol/sdk`, `zod`, a bundler such as esbuild or tsup). `pnpm-lock.yaml` changes.
- **CI**: new workflow file for the MCP image; `ghcr.yml` untouched apart from possibly path filters.
- **Docs**: new page under `docs/user-guides/`, `README.md` fork section, `CLAUDE.md`.
- **Runtime**: MCP traffic counts against the backend's per-IP rate limit (100/min by default); the HTTP transport forwards each client's IP to keep buckets separate.
