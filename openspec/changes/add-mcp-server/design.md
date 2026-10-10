## Context

Open Archiver's REST API is the fork's public contract (see `CLAUDE.md`), used by the SvelteKit frontend, API-key clients and, after this change, an MCP server. The full handoff plan, with the user's decisions, is `.claude/plans/mcp-server.md`; this design records how to build it.

What the code does today:

- `requireAuth` accepts `X-API-KEY` and maps it to a user; CASL and audit logging apply as for a UI login.
- `ArchivedEmailService.getArchivedEmailById` loads the row, checks `read archive` against it, writes a `READ` audit entry, loads thread siblings across the merge group and the attachment rows, and reads the .eml from storage into `raw` (a `Buffer`, serialized as a byte array). The controller turns `null` (missing or forbidden) into `404 archivedEmail.notFound`.
- `SearchService.search` always sends `attributesToHighlight: ['*']` and `showMatchesPosition: true`, and returns Meilisearch hits unchanged, so each hit carries the document and a full highlighted copy. The access filter comes from `FilterBuilder.create(userId, 'archive', ['read', 'search'])`.
- Meilisearch documents (`EmailDocument`) hold attachments as `{ filename, content }`, without the attachment's database id. Attachment text exists only there.
- The backend already depends on `mailparser` 3.7, `meilisearch` 0.51 and `zod` 4. `html-to-text` 9.0.5 is in the lockfile as a dependency of `mailparser`, not of the backend.
- Rate limit: 100 requests per minute per IP; `app.set('trust proxy', true)` is set, so `X-Forwarded-For` decides the IP.

## Goals / Non-Goals

**Goals:**

- Give AI clients compact, readable access to search, emails, threads, attachment text, sources and stats.
- Keep permissions, IAM conditions and auditing in the backend.
- Change the API only by adding to it.
- Stay easy to merge with upstream: new files, small edits.

**Non-Goals:**

- Write or destructive tools, OAuth, claude.ai web/mobile support.
- A public HTTP deployment guide, an npm package.
- Changing the frontend search page to use the new search parameters.
- Mailbox counts (facets give values only).

## Decisions

### D1. Parse on the server, in a new endpoint

`GET /v1/archived-emails/{id}/content` parses the stored .eml with `mailparser`'s `simpleParser`.
_Alternative:_ parse `raw` in the MCP server. Rejected by the user: every client would need MIME parsing, and `raw` costs about 4× the email's size on the wire.

### D2. One shared read path for both endpoints

Split `getArchivedEmailById` so the permission check, audit entry, thread lookup and attachment lookup live in one private helper (for example `#loadReadableEmail(emailId, userId, actor, actorIp)` returning the row, thread and attachments, or `null`). The existing method adds `raw` to its result; a new `getArchivedEmailContent` adds parsed fields. An IAM fix then applies to both, which the spec requires. The existing response must stay byte-for-byte the same.

### D3. Text from HTML

Use mailparser's `text` when the message has a plain-text part. When it has only HTML, use mailparser's own HTML-to-text output if `parsed.text` is filled (mailparser 3 derives it with `html-to-text`); otherwise convert `parsed.html` with `html-to-text`, added as a direct backend dependency at the version already in the lockfile (9.0.5), so no new package is downloaded. Check which case applies when implementing; don't add the dependency if it isn't needed.

### D4. Attachment text from Meilisearch, matched by filename

When `includeAttachmentText=true`, fetch the email's document with `index.getDocument(id, { fields: ['attachments'] })`. A missing document (Meilisearch `document_not_found`) means "not indexed": every `text` is `null`. Match database attachments to document entries by filename, in order, so two attachments with the same name pair up by position. Fetching the document by id after the row-level permission check is safe: the caller has already been authorised for this email.
_Alternative:_ re-extract with Tika on request. Rejected: slow, and Tika may not be running.

### D5. `maxChars` cuts `text` only

Truncation applies to `text`, not to `html` or attachment text; the MCP server truncates attachment text itself. The cut is by UTF-16 code units (JavaScript string length); a cut that would split a surrogate pair moves back one unit.

### D6. Search parameters map onto Meilisearch options

- `fields` → `attributesToRetrieve` (always adding `id`), validated against the `EmailDocument` keys: `id, userEmail, from, fromName, to, cc, bcc, subject, body, attachments, timestamp, ingestionSourceId, hasAttachments`, plus the nested `attachments.filename` (added during implementation so `archive_search`'s detailed mode can list attachment names without downloading their text; Meilisearch supports nested paths in `attributesToRetrieve`).
- `crop` → `attributesToCrop`, allowed values `subject`, `body`, `attachments.content`; `cropLength` → `cropLength`.
- When either is present, `attributesToHighlight` becomes the union of `fields` and `crop` instead of `['*']`. Meilisearch only puts retrieved attributes into `_formatted`, so cropped attributes are added to `attributesToRetrieve`, and the controller removes the uncropped originals from each hit when they weren't listed in `fields`. Verify this against Meilisearch 0.51 behaviour during implementation, since the exact `_formatted` rules decide whether that clean-up step is needed.
- None of these change `filter`, `sort`, `offset`, `limit` or the audit entry. The audit `details` may record the new parameters.

### D7. MCP server structure

- `packages/mcp-server`, ESM, TypeScript, bundled with esbuild into `dist/index.js`. `@open-archiver/types` is imported as types only, so the bundle has no runtime dependency on the workspace.
- `src/client.ts`: `createClient({ baseUrl, apiKey, forwardedFor? })` with typed `get<T>(path, query)`; maps status codes to `ToolError` messages (spec "Readable errors"). Reads `Retry-After` / `RateLimit-Reset` headers for 429s.
- `src/tools/*.ts`: one module per tool exporting `register(server, getClient)`; zod input and output schemas; each result returns `structuredContent` plus the same data as compact JSON text (D10).
- `src/instructions.ts`: the server-level `instructions` string (D11).
- `src/stdio.ts`, `src/http.ts`, `src/index.ts` (dispatches on `process.argv[2]`).
- HTTP: SDK `StreamableHTTPServerTransport` in stateless mode, one server per request, with the client built from that request's bearer token and `req.socket.remoteAddress` (or an incoming `X-Forwarded-For` when the server itself is behind a proxy configured to be trusted). Env: `MCP_HOST` (default `127.0.0.1`), `MCP_PORT` (default `3333`), `MCP_ALLOWED_HOSTS`, `OPEN_ARCHIVER_URL`.
  _Alternative:_ stateful sessions. Rejected: no tool needs session state, and stateless mode needs no session store.

### D8. Thread fan-out bounded

`get_thread` fetches at most 20 messages (the requested one plus the 19 nearest by date), with `maxChars` 2 000 each, sequentially with a small concurrency (3). Each fetch also writes a `READ` audit entry, which is correct: the model did read them.

### D9. Packaging

- `packages/mcp-server/Dockerfile`: multi-stage, builds the bundle in the monorepo context, final stage `node:22-alpine` with only `dist/index.js` and the SDK's runtime deps (or a fully bundled file with none). `ENTRYPOINT ["node", "/app/index.js"]`, `CMD ["http"]`, `MCP_HOST=0.0.0.0` inside the image, since Docker networking needs it; the compose example doesn't publish the port to the host.
- `.github/workflows/ghcr-mcp.yml`: triggers on pushes to `main` touching `packages/mcp-server/**` or `packages/types/**`; tags as `ghcr.yml` does (12-char SHA, `main`, `latest`).
- `ghcr.yml` builds the main image on every non-Markdown push; adding `packages/mcp-server/**` to its `paths-ignore` is optional and only saves a build.

### D10. Tool shape follows current agent-tool practice

- **Names** are prefixed `archive_`. Clients show every connected server's tools to the model in one list, and generic names like `search_emails` are what Gmail and Outlook servers use; the prefix tells the model which mail it is searching. Names stay snake_case and verb-first after the prefix.
- **Annotations**: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` (a closed archive, not the web). Clients use these to skip confirmation prompts.
- **Output**: every tool declares an `outputSchema` (zod) and returns `structuredContent` and a JSON text block. Shared shapes (hit, email header, source ref, paging) live in `src/schemas.ts`.
- **Model-friendly values**: ISO 8601 UTC timestamps instead of epoch numbers (the search index stores `timestamp` as epoch ms); source names next to ids, resolved from `GET /v1/ingestion-sources` and cached per client for 60 seconds, so one search doesn't cost an extra request; paging as `{ page, totalPages, total, nextPage }` with `nextPage: null` on the last page.
- **`detail` switch on search**: `concise` by default; `detailed` adds recipients, mailbox and attachment names. Neither returns full bodies; that's `archive_get_email`'s job.
- **Errors** are `isError: true` results with a message saying what failed and what to try next. `400` messages pass through the API's translated `message`, which names the bad parameter.
- **Inputs are strict** (`z.strictObject`): an argument the tool doesn't know is a validation error naming the key, not silently dropped. Added after the evaluation run, where dropped arguments turned guessed calls into confusing "keywords are required" errors.
- **`archive_search` takes `query`**, not the API's `keywords`. In the first evaluation run models guessed `query` before reading the schema on 7 of 12 questions; the server maps it to `keywords`.
- **A 403 without the API's JSON error** is reported as a refusal by something in front of Open Archiver (a reverse proxy, a dev server's Host check), not as a missing permission.
  _Alternative:_ plain text results only. Rejected: structured output lets clients render and validate results, and the text block keeps older clients working.

### D11. Server instructions carry the shared rules

The initialize result's `instructions` explain once: archive not live mailbox, keyword (not semantic) search, merge-group expansion, UTC dates, OR within / AND across filter fields, paging, the shared rate limit, and that email content is data, not instructions. Tool descriptions stay short and specific to each tool. Clients that ignore `instructions` still work; the key facts that change how a single tool is called (date format, filter semantics) are repeated in that tool's parameter descriptions.

### D12. Email content is untrusted

Anyone can send an email, so archived bodies, subjects, sender names and attachment text may contain prompt-injection attempts. The server can't detect those reliably, so it limits what they can do:

- email-derived text appears only in dedicated structured fields (`subject`, `snippet`, `body`, `attachmentText`, `fromName`) and is never interpolated into server-written `hint`, `note` or error messages;
- the server instructions say tool output from email is data, not instructions;
- having no write tools means an injected instruction can't make this server change anything;
- the user guide warns that pairing the server with tools that send data out (web fetch, email sending) lets an injected email try to exfiltrate archive data, and recommends a narrowly scoped read-only role.
  _Alternative:_ sanitize or filter suspicious text. Rejected: unreliable, and it would alter archived evidence.

### D13. Evaluation set

`packages/mcp-server/eval/questions.md` holds ten or more questions about the seed archive with expected answers, covering each tool and some multi-step tasks (search then read a thread; find an attachment then read its text; scope to one source of a merge group). Run them in Claude Code, record the tool calls per question, and adjust descriptions and result shapes where the model picks the wrong tool, retries, or pulls in far more text than needed. This is a manual run, matching the repo's lack of an automated test suite.

## Risks / Trade-offs

- [The new endpoint reads the whole .eml into memory and parses it; large emails cost CPU per call.] → Same cost as the existing endpoint's `raw` read. Parsing is per request, without caching; revisit only if it shows up.
- [Filename matching can mis-pair attachments when names repeat in a different order in the index.] → Pair by position within the same filename; the index was built from the same parse, so order matches in practice.
- [Meilisearch `_formatted` semantics may differ from the assumption in D6.] → Verify against the running Meilisearch version before writing the controller logic; the spec defines the observable result, not the mechanism.
- [Each `get_thread` call can use up to 21 of the 100 requests per minute.] → Cap, report omissions, and tell the model about the limit in the tool description.
- [HTTP mode trusts its own client's IP for `X-Forwarded-For`; if exposed publicly anyone could spoof it.] → v1 binds to localhost / the Docker network and the docs give no public setup. The backend already trusts the header from anyone.
- [Search hits' `_formatted` and `_matchesPosition` shapes are now part of the contract for the new parameters.] → Document them in the `@openapi` block.
- [Upstream may later change `getArchivedEmailById`.] → The refactor is local to one method and keeps its signature, so merge conflicts stay small.
- [Prompt injection through archived email can't be prevented by the server.] → Keep email text in its own fields, say so in the instructions, ship no write tools, and warn in the docs (D12).
- [The source-name cache can show a renamed source's old name for up to 60 seconds.] → Acceptable for an archive; ids stay authoritative.

## Migration Plan

No data migration. Deploy order: backend first (the MCP server needs `/content` and the search parameters), then the MCP image. Rolling back the backend breaks the MCP server but nothing else, since the frontend uses neither addition.

## Open Questions (resolved during implementation)

- **mailparser and HTML-only mail:** `simpleParser` fills `parsed.text` from the HTML part itself, via `html-to-text` (headings uppercased, lists as `*`, scripts and styles dropped). D3 needs no new dependency; `text` is `parsed.text`.
- **Meilisearch v1.38 `_formatted`:** cropped attributes appear in `_formatted` even when they aren't in `attributesToRetrieve`, and are not added to the top-level hit. D6's clean-up step isn't needed. `_formatted` always carries `id`. Cropping `attachments.content` keeps the array shape but returns only `content` for each entry (no `filename`).
- **Stored .eml files have their attachments stripped** (`stripAttachmentsFromEml` at ingestion); attachments live in their own storage files. `/content` therefore takes the attachment list from the `attachments` table, as D4 already does, and never from the parsed .eml.
