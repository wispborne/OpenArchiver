# Handoff: MCP server

Status: planned and agreed with the user, no code written yet. Read `CLAUDE.md` first; this file assumes it.

## Goal

A read-only MCP server that lets AI clients search and read the archive. It talks to the REST API over HTTP with an API key, never to Postgres or Meilisearch, so permissions, IAM conditions and audit logging stay in the backend.

## Decisions already made

| Question                       | Decision                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Clients                        | Claude Code / Claude Desktop (local), and other MCP clients (Cursor, Open WebUI, etc.). **Not** claude.ai web/mobile, so no OAuth. |
| Transports                     | Both, from one codebase: stdio, and Streamable HTTP as an optional Docker service.                                                 |
| How `get_email` reads the body | A new additive API endpoint that parses the email on the server. Not parsing `raw` in the MCP server.                              |
| v1 scope                       | Read-only tools, plus attachment text. No sync, job, merge or delete tools.                                                        |
| HTTP mode exposure             | Localhost / Docker network only in v1. Don't document a public setup. Turn on the SDK's DNS-rebinding protection.                  |
| Search payload                 | Add optional crop and field-selection parameters to `/v1/search` in Phase 1 (see below). Defaults unchanged.                       |
| Distribution                   | No npm package for now. One Docker image runs both stdio (`docker run -i … stdio`) and HTTP. Bundle to a single file.              |

## What exists today (verified against the code)

- **Auth:** `requireAuth` (`packages/backend/src/api/middleware/requireAuth.ts`) accepts an `X-API-KEY` header and maps it to a user; CASL and audit logging then apply as for a UI login. Keys expire (`expiresInDays` at creation).
- **Rate limit:** 100 requests per minute per IP by default (`RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`), applied to every route except `auth/status` and `settings/system`. An MCP container counts as one IP. Fine for one user, but `get_thread` fanning out over a long thread can hit it. Surface 429 as a readable tool error.
- **Search:** `GET /v1/search` with `keywords`, `sources`, `excludeSources`, `from`, `notFrom`, `to`, `notTo`, `mailboxes`, `dateFrom`, `dateTo`, `searchIn`, `hasAttachments`, `sort`, `page`, `limit`, `matchingStrategy`. Requires `search:archive`. Each hit is a full `EmailDocument` (`packages/types/src/email.types.ts`), including the **whole body and every attachment's extracted text**, plus `_matchesPosition`. Because `SearchService.search` sets `attributesToHighlight: ['*']`, each hit also carries `_formatted`, a second, highlighted copy of every field. Ten hits with a few large PDFs can be megabytes. The frontend search page reads only `_formatted.subject`, `from`, `fromName`, `to` and a body snippet.
- **Facets:** `GET /v1/search/facets?field=mailboxes|from&query=…`; an empty `query` returns the most common values. Good enough for `list_mailboxes` in v1 (no counts).
- **Read an email:** `GET /v1/archived-emails/{id}` (`ArchivedEmailService.getArchivedEmailById`). Checks `read archive` against the row, writes a `READ` audit entry, returns metadata, `attachments`, `thread` (siblings across the merge group: id, subject, sentAt, sender) and `raw`. `raw` is a Node `Buffer`, so it serializes as `{ "type": "Buffer", "data": [ …bytes… ] }`: about 4× the email's size and unusable without MIME parsing. This is why a new endpoint is needed.
- **Sources:** `GET /v1/ingestion-sources` and `/{id}` already strip `credentials` (`toSafeIngestionSource` in `ingestion.controller.ts`). Stats: `GET /v1/ingestion-sources/{id}/stats`. Overview: `GET /v1/dashboard/stats`.
- **Attachment text** is stored only in Meilisearch (`EmailDocument.attachments[].content`, extracted by Tika at indexing). The `attachments` table has filename, MIME type, size, hash and storage path, no text. Unindexed emails have no attachment text.
- **Libraries already in the backend:** `mailparser` (with `@types/mailparser`) and `meilisearch`. `SearchService.getIndex()` gives index access; a single document can be fetched by email id.

## Plan

### Phase 1: API addition (backend, additive)

`GET /v1/archived-emails/{id}/content`

- Route next to the existing one in `archived-email.routes.ts`, with `requirePermission('read', 'archive')` and an `@openapi` block. Mind the YAML pitfall in `CLAUDE.md` (no `: ` inside descriptions) and check that the generator's path count rises.
- Same row-level permission check and `READ` audit entry as `getArchivedEmailById`; reuse that code path rather than copying it, so an IAM fix applies to both.
- Parse the stored .eml with `mailparser`'s `simpleParser`. Response (new type in `packages/types/src/archived-emails.types.ts`):
    - `id`, `subject`, `from`, `to`, `cc`, `bcc`, `sentAt`, `messageId`, `inReplyTo`, `references`, `userEmail`, `ingestionSource { id, name }`
    - `text`: the plain-text part, or a text rendering of the HTML part when there is none (mailparser's `textAsHtml`/`html` plus a small HTML-to-text step; check whether `html-to-text` is already a transitive dependency before adding one)
    - `html` only when `includeHtml=true`
    - `attachments[]`: `id`, `filename`, `mimeType`, `sizeBytes`, and `text` only when `includeAttachmentText=true` (read from the email's Meilisearch document; `null` when the email isn't indexed)
    - `thread[]`: same as the existing endpoint
    - `truncated: boolean`
- Optional `maxChars` (applies to `text`, default unlimited for API clients; the MCP server passes its own default).
- Add strings to `packages/backend/src/locales/en/translation.json`, regenerate `docs/api/openapi.json` (`pnpm docs:gen-spec`), add the endpoint to the README's "Differences from upstream" list.

`GET /v1/search`: new optional parameters (additive; omitting them must give exactly today's response, so the frontend and existing clients see no change):

- `fields`: comma-separated list of `EmailDocument` attributes to return (`attributesToRetrieve`); `id` is always included. Validate against the known attribute names.
- `crop`: comma-separated attributes to crop (`attributesToCrop`), e.g. `body,attachments.content`, plus `cropLength` (words, Meilisearch default 10; the MCP server will ask for ~50).
- When either is given, limit `attributesToHighlight` to the returned or cropped attributes instead of `['*']`, so `_formatted` stops duplicating whole bodies.
- Meilisearch centres crops on the match (typos and prefixes included), so the MCP server uses `_formatted.body` as its snippet instead of rebuilding one from `_matchesPosition`.
- Update the search route's `@openapi` block and the request DTO type in `packages/types`. The frontend search page could adopt this later; not part of this work.

Not needed in v1: a mailbox-listing endpoint (facets cover it).

### Phase 2: `packages/mcp-server`

- New workspace package using the official TypeScript MCP SDK (`@modelcontextprotocol/sdk`). Import types from `@open-archiver/types`.
- Layout:
    - `src/client.ts`: a fetch wrapper with base URL and API key. Maps 401 / 403 / 404 / 429 to readable tool errors ("the key's role lacks `search:archive`", "rate limited, retry in N seconds").
    - `src/tools/*.ts`: one module per tool, input schemas with zod.
    - `src/stdio.ts`: env `OPEN_ARCHIVER_URL`, `OPEN_ARCHIVER_API_KEY`.
    - `src/http.ts`: Streamable HTTP. Each request carries the API key as `Authorization: Bearer <key>`, which is forwarded as `X-API-KEY`. The server stores no secret of its own. Bind to localhost / the Docker network by default, and enable the SDK's DNS-rebinding protection (allowed hosts/origins).
    - Rate limit in HTTP mode: every backend request comes from the MCP container's IP, so all clients share one 100/min bucket. The backend sets `trust proxy` to `true` (`server.ts`), so forward the MCP client's IP as `X-Forwarded-For` to give each client its own bucket.
    - One entry point (`src/index.ts`) that takes `stdio` or `http` as its argument, bundled to a single file with esbuild or tsup (`@open-archiver/types` is compile-time only). This keeps an npm package a publish step away.
- Tools, all with `readOnlyHint: true`:

    | Tool                  | Endpoint                                                  | Notes                                                                                                                                               |
    | --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `search_emails`       | `GET /v1/search` with `fields` and `crop=body`            | Return id, date, from, to, subject, mailbox, source, and the cropped body as snippet. Expose the filters, `page`, `limit` (default small, e.g. 10). |
    | `get_email`           | `GET /v1/archived-emails/{id}/content`                    | Pass a default `maxChars` (e.g. 20 000) and let the model ask for more.                                                                             |
    | `get_thread`          | `/content` of the given email, then each `thread[]` entry | Short bodies per message; cap the number fetched to stay under the rate limit.                                                                      |
    | `get_attachment_text` | `/content?includeAttachmentText=true`                     | By email id and attachment id or filename.                                                                                                          |
    | `list_sources`        | `GET /v1/ingestion-sources`                               | Trim to id, name, provider, status, merge parent.                                                                                                   |
    | `get_source_stats`    | `GET /v1/ingestion-sources/{id}/stats`                    |                                                                                                                                                     |
    | `list_mailboxes`      | `GET /v1/search/facets?field=mailboxes`                   | Optional prefix.                                                                                                                                    |
    | `archive_overview`    | `GET /v1/dashboard/stats`                                 |                                                                                                                                                     |

- Tool descriptions should tell the model that source ids expand to their merge group, that dates are UTC `yyyy-mm-dd`, and that list filters are OR within a field and AND across fields.

### Phase 3: packaging and docs

- One image, `ghcr.io/wispborne/open-archiver-mcp`, built by a new fork-only workflow file (don't edit `ghcr.yml` more than needed; keep upstream merges clean). It runs either transport:
    - stdio: `docker run -i --rm -e OPEN_ARCHIVER_URL -e OPEN_ARCHIVER_API_KEY ghcr.io/wispborne/open-archiver-mcp stdio`, usable as the `command` in Claude Code / Claude Desktop config.
    - HTTP: an example `mcp` service for `docker-compose.override.yml`, on the Docker network only.
- From a clone: `node packages/mcp-server/dist/index.js stdio`. No npm package for now.
- A docs page under `docs/user-guides/` (watch the VitePress `{{ }}` pitfall): create a dedicated read-only role and an API key for it, Claude Code / Claude Desktop config snippets (Docker and from a clone), the HTTP setup on the Docker network, and what each tool does. No public-exposure setup.
- Update the README differences list and the "MCP server" section of `CLAUDE.md` (it still says "planned").

## Verification

There is no test suite. Run it for real:

1. Start Postgres, Redis, Meilisearch (version from `docker-compose.yml`), the API and the workers as `CLAUDE.md` describes. Seed mail with an `mbox_import` source; include a multipart email with an HTML-only part, an attachment, and a reply so there's a thread.
2. Phase 1: `curl` `/v1/search` without the new parameters and confirm the response is unchanged (diff against `main`), then with `fields` and `crop` and confirm `_formatted` no longer holds whole bodies. `curl` the new `/content` endpoint with an API key: plain text, HTML-only, `includeHtml`, `includeAttachmentText` on an indexed and an unindexed email (`is_indexed = false`), `maxChars`, a 404, and a key whose role can't read that mailbox (expect the same refusal as the existing endpoint). Confirm a `READ` audit entry is written.
3. Phase 2: every tool through the MCP Inspector over stdio and over HTTP; then a real Claude Code session with the server configured.
4. Backend typecheck, `pnpm lint`, and `pnpm --filter @open-archiver/types build` before pushing.

## Later, if asked

- A public HTTP setup (behind the user's own reverse proxy with TLS).
- Publishing the stdio server to npm.
- Switching the frontend search page to `fields` / `crop`.
