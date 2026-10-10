## 1. Environment

- [x] 1.1 `git fetch origin main`, install dependencies (`xlsx` override workaround if the install fails; never commit it), build `@open-archiver/types`
- [x] 1.2 Start Postgres, Redis and Meilisearch (version from `docker-compose.yml`), run migrations, build and start the API and the indexing and ingestion workers, create the first user with `POST /v1/auth/setup`
- [x] 1.3 Seed an mbox with: a plain-text email, an HTML-only email, a multipart email with a PDF attachment, two attachments sharing one filename, a three-message thread, one email over 50 000 characters, and one email whose body contains a prompt-injection attempt; enough varied senders, topics and dates to support the evaluation questions in 6.6; import it with an `mbox_import` source and wait for indexing
- [x] 1.4 Create an API key for the admin, a read-only role limited to one mailbox, and an API key for a user with that role
- [x] 1.5 Save `/v1/search` responses for three queries (keywords only, with filters, with `searchIn`) as the baseline for the "unchanged default" check
- [x] 1.6 Resolve design open questions: does mailparser fill `parsed.text` for the HTML-only email, and what does Meilisearch return in `_formatted` with `attributesToRetrieve` + `attributesToCrop`? Note the answers in `design.md`

## 2. Email content endpoint (backend)

- [x] 2.1 Add `ArchivedEmailContent` (and its attachment and query types) to `packages/types/src/archived-emails.types.ts`; rebuild types
- [x] 2.2 Extract the permission check, `READ` audit, thread lookup and attachment lookup from `ArchivedEmailService.getArchivedEmailById` into one shared helper; keep the existing method's output identical
- [x] 2.3 Add `ArchivedEmailService.getArchivedEmailContent(emailId, userId, actor, actorIp, { includeHtml, includeAttachmentText, maxChars })`: parse with `simpleParser`, build `text` (HTML fallback per design D3), apply `maxChars`, set `truncated`
- [x] 2.4 Attachment text: fetch the email's Meilisearch document (`attachments` field only), treat not-found as unindexed, pair by filename and position
- [x] 2.5 Controller method: validate `includeHtml`, `includeAttachmentText` (`true`/`false`) and `maxChars` (positive integer, else `400`), `404` with `archivedEmail.notFound` on `null`
- [x] 2.6 Route `GET /:id/content` with `requirePermission('read', 'archive')` and an `@openapi` block (no `: ` inside descriptions)
- [x] 2.7 Add new strings to `packages/backend/src/locales/en/translation.json`
- [x] 2.8 Verify with `curl` against every scenario in `specs/email-content-api/spec.md`, including the restricted key (expect `404`, no audit row), an unindexed email (`is_indexed = false` and its Meilisearch document deleted), and a `READ` row in the audit log; confirm `GET /v1/archived-emails/{id}` output is unchanged

## 3. Search result shaping (backend)

- [x] 3.1 Add optional `fields`, `crop`, `cropLength` to `SearchQuery` in `packages/types/src/search.types.ts`
- [x] 3.2 Parse and validate them in `search.controller.ts` (allowed field and crop names from design D6, `cropLength` positive integer and only with `crop`), with `400` and translated messages
- [x] 3.3 In `SearchService.search`, set `attributesToRetrieve`, `attributesToCrop`, `cropLength` and the narrowed `attributesToHighlight` only when the new parameters are present; strip uncropped originals from hits if 1.6 showed it is needed
- [x] 3.4 Update the `/v1/search` `@openapi` block with the three parameters
- [x] 3.5 Verify: the three baseline queries return identical responses (diff against 1.5); `fields`/`crop` scenarios from `specs/search-result-shaping/spec.md`; same ids, order and `total` with and without the new parameters; the frontend search page still works in a browser

## 4. Backend wrap-up

- [x] 4.1 `pnpm docs:gen-spec`; check the output has no `YAMLSemanticError`, the path count rose by one and `/v1/search` lists the new parameters; commit `docs/api/openapi.json`
- [x] 4.2 Backend typecheck, `pnpm --filter @open-archiver/frontend check`, `pnpm lint` on changed files that were clean before
- [x] 4.3 Add both API additions to the README's "Differences from upstream" list
- [ ] 4.4 Commit (`feat(api): …`) and push; this ships the main image, so 4.1–4.2 must pass first

## 5. MCP server package

- [x] 5.1 Create `packages/mcp-server` (`package.json` with `@modelcontextprotocol/sdk`, `zod`, `esbuild`; `tsconfig.json`; build script producing `dist/index.js`); add it to the workspace and confirm `pnpm install` and the root scripts still work
- [x] 5.2 `src/client.ts`: base URL, `X-API-KEY`, optional `X-Forwarded-For`, typed GET with query encoding, actionable error mapping for 400/401/403/404/429/network (design D10)
- [x] 5.3 `src/schemas.ts` (shared zod shapes: hit, email header, source ref, paging, ISO timestamp conversion), `src/instructions.ts` (server instructions per design D11), source-name lookup with a 60-second cache; register tools with `archive_` names, the three annotations and output schemas; every result returns `structuredContent` plus JSON text
- [x] 5.4 `archive_search` with filters, `page`, `limit` (default 10), `detail` (`concise`/`detailed`), `fields` + `crop=body&cropLength=50`, paging with `nextPage`
- [x] 5.5 `archive_get_email` (default `maxChars` 20 000, truncation hint naming the `maxChars` to use)
- [x] 5.6 `archive_get_thread` (cap 20, 2 000 chars each, concurrency 3, report omitted count)
- [x] 5.7 `archive_get_attachment_text` (by id or filename, own truncation, explanatory message for `null`)
- [x] 5.8 `archive_list_sources` (trimmed fields, merge parent id and name), `archive_get_source_stats`, `archive_list_mailboxes` (prefix filter), `archive_overview`
- [x] 5.9 Check that no server-written `hint`, `note` or error text interpolates email-derived text (design D12)
- [x] 5.10 `src/stdio.ts` with env checks; `src/index.ts` dispatching `stdio` / `http`
- [x] 5.11 `src/http.ts`: stateless Streamable HTTP, bearer token required (`401` otherwise), per-request client, `X-Forwarded-For`, DNS-rebinding protection with `MCP_ALLOWED_HOSTS`, `MCP_HOST` default `127.0.0.1`, `MCP_PORT` default `3333`
- [x] 5.12 Typecheck and lint the package

## 6. MCP verification

- [x] 6.1 MCP Inspector over stdio: initialize result carries the instructions; tool list shows `archive_` names, annotations and output schemas; every tool with the admin key returns `structuredContent` that validates, ISO timestamps and source names; error cases (bad key → 401 message, restricted key calling `list_sources` → permission message, unknown email → 404 message)
- [x] 6.2 Force a 429 (lower `RATE_LIMIT_MAX_REQUESTS`, run `get_thread` repeatedly) and check the message
- [x] 6.3 MCP Inspector over HTTP: same tools; no bearer → 401; wrong `Host` → rejected; backend sees the client IP in `X-Forwarded-For`
- [x] 6.4 Restricted key: `archive_search` and `archive_get_email` only see the allowed mailbox
- [x] 6.5 Read the prompt-injection email through `archive_get_email` and `archive_search`; confirm its text appears only in content fields
- [x] 6.6 Write `packages/mcp-server/eval/questions.md`: ten or more questions about the seed archive with expected answers, covering every tool and multi-step tasks (design D13)
- [x] 6.7 Run the evaluation set in a real Claude Code session with the stdio server and the Gmail MCP server both configured; record the tool calls per question, confirm the model picks the `archive_` tools for archive questions, and adjust descriptions or result shapes where it chose wrongly, retried or loaded far more text than needed

## 7. Packaging

- [x] 7.1 `packages/mcp-server/Dockerfile` (multi-stage, `ENTRYPOINT node index.js`, `CMD http`, `MCP_HOST=0.0.0.0`); build and run it locally in both modes, including `docker run -i … stdio` from a Claude Code config
- [x] 7.2 `.github/workflows/ghcr-mcp.yml` publishing `ghcr.io/wispborne/open-archiver-mcp` (12-char SHA, `main`, `latest`) on pushes touching `packages/mcp-server/**` or `packages/types/**`
- [x] 7.3 Example `mcp` service for `docker-compose.override.yml` on the Docker network, without a published port

## 8. Docs and wrap-up

- [x] 8.1 `docs/user-guides/mcp-server.md`: create a read-only role and API key, Claude Code and Claude Desktop config (Docker and from a clone), HTTP setup on the Docker network, what each tool does, rate-limit note, and a prompt-injection warning (archived email is untrusted; be careful combining this server with tools that send data out; use a narrowly scoped read-only role); no `{{ }}` outside fenced blocks; add to the VitePress sidebar; build the docs
- [x] 8.2 README "Differences from upstream": the MCP server and image
- [x] 8.3 `CLAUDE.md`: replace "MCP server (planned)" with how the package is laid out, built and verified; mark `.claude/plans/mcp-server.md` as done or remove it
- [ ] 8.4 Commit (`feat(mcp): …`) and push; confirm the new workflow publishes the image
