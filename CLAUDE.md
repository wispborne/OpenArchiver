# CLAUDE.md

A personal fork of [Open Archiver](https://github.com/LogicLabs-OU/OpenArchiver) (upstream), an email archiving platform. The fork lives at `wispborne/OpenArchiver`.

## Goals of this fork

1. **Better UI/UX.** Improve the SvelteKit frontend freely: layout, flows, wording, empty and error states, feedback for background jobs.
2. **Keep the REST API stable.** The API is a public contract, used by the frontend, by API-key clients and by the MCP server. Change it by adding: new endpoints, new optional fields, new optional parameters. Don't rename, remove or change the meaning of existing endpoints, fields or status codes. If a breaking change is unavoidable, say so explicitly and update every consumer in the same commit.
3. **Maintain an MCP server** (planned, not built yet) that exposes the archive to AI clients through the REST API. See "MCP server" below.

Also keep the fork easy to sync with upstream: prefer new files and small, well-placed edits over rewrites of upstream code.

## Workflow

- If a request would be too hard or too risky for this project (data loss in the archive, a breaking API change, a large divergence from upstream, more work than it is worth), say so plainly before starting, and propose a smaller or safer alternative. The user prefers that to a half-working or fragile result.
- Commit directly to `main`. No PRs or feature branches unless asked.
- Every push to `main` that touches anything other than Markdown or `docs/` builds and publishes the Docker image `ghcr.io/wispborne/open-archiver` (tags: first 12 characters of the SHA, `main`, `latest`). This is done by `.github/workflows/ghcr.yml`. The deployment pins images by SHA, so a broken push ships a broken image: typecheck, and run the change for real, before pushing. Upstream's Docker Hub workflows (`docker-deployment.yml`, `release-tag.yml`) are disabled in the repo's Actions settings. Keep fork-only CI in separate files so upstream merges don't conflict with it.
- `git fetch origin main` before starting work. Other sessions also push to `main`.
- `README.md` opens with a fork section whose "Differences from upstream" list is kept current. A commit that adds or changes something a user or API client would notice updates that list in the same commit; internal refactors and docs-only changes don't. Keep the section above upstream's `# Open Archiver` title so upstream README changes still merge cleanly.
- Commit messages follow the existing style: `feat(scope): …`, `fix(scope): …`, imperative mood, first line ≤ 72 characters, with a body that explains why.
- To sync upstream: `git remote add upstream https://github.com/LogicLabs-OU/OpenArchiver` (if missing), `git fetch upstream`, then merge `upstream/main` into `main`. Upstream sometimes squashes enterprise-edition commits into one ("ee commit …"). The fork's own migration is `0045` (mailbox merge); if upstream ships a migration with the same number, the two journals conflict and one has to be renumbered. After a sync, remove anything from the README's differences list that upstream now has too.

## Repository layout

pnpm monorepo (pnpm 10.13.1, Node ≥ 22).

| Path                 | What                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/backend`   | Express 5 API, Drizzle ORM (Postgres), BullMQ (Redis/Valkey) jobs, Meilisearch indexing, ingestion connectors |
| `packages/frontend`  | SvelteKit 2, Svelte 5 (runes), Tailwind 4, shadcn-svelte (bits-ui) in `src/lib/components/ui/`, lucide icons  |
| `packages/types`     | Shared TypeScript types used by both sides. Put new API types here.                                           |
| `apps/open-archiver` | OSS server entry point (`createServer([])`)                                                                   |
| `docs/`              | VitePress docs. `docs/api/openapi.json` is generated and committed.                                           |

The enterprise package and app (`packages/enterprise`, `apps/open-archiver-enterprise`) are referenced in scripts but are not in this repo. Enterprise-only UI is gated on `data.enterpriseMode`.

Runtime processes: the API server, plus three workers in `packages/backend/src/workers/` and `jobs/schedulers/`:

- **ingestion**: sync and import jobs, one `process-mailbox` job per mailbox
- **indexing**: Meilisearch indexing, reindex, reconcile, and maintenance jobs such as the duplicate sweep and mailbox merge
- **sync-scheduler**

A job name must be registered in its worker's `switch` or it fails with "Unknown job name".

## Commands

```sh
pnpm install --frozen-lockfile
pnpm --filter @open-archiver/types build                                  # backend/frontend import types from dist
cd packages/backend && ./node_modules/.bin/tsc --noEmit -p .              # backend typecheck
pnpm --filter @open-archiver/frontend check                               # svelte-check
pnpm lint                                                                 # prettier --check (pnpm format to fix)
pnpm db:generate                                                          # drizzle-kit migration from schema changes
pnpm docs:gen-spec                                                        # regenerate docs/api/openapi.json
```

There is no automated test suite. Verify changes by running them:

- In cloud sessions, `.claude/hooks/session-start.sh` runs at startup. It installs dependencies (working around the `xlsx` failure below), builds `@open-archiver/types`, starts Postgres with a superuser `oa` / password `oa` and a database `oa` (`DATABASE_URL=postgresql://oa:oa@localhost:5432/oa`), and starts Redis on the default port. It does not fetch Meilisearch: download that binary from GitHub releases when you need search, matching the version in `docker-compose.yml`. Chromium is preinstalled.
- Run migrations with `ts-node-dev --transpile-only src/database/migrate.ts`.
- Start the API with `node apps/open-archiver/dist/index.js` and the workers from `packages/backend/dist/workers/` after `pnpm --filter @open-archiver/backend build && pnpm --filter open-archiver-app build`.
- Start the frontend with `vite dev` in `packages/frontend`. It proxies `/api` to `PORT_BACKEND`.
- The API needs at least `DATABASE_URL`, `REDIS_*`, `MEILI_HOST`, `MEILI_MASTER_KEY`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `ENCRYPTION_KEY`, `STORAGE_TYPE=local`, `STORAGE_LOCAL_ROOT_PATH` and `PORT_BACKEND`. Create the first user with `POST /v1/auth/setup`.
- Drive the UI with Playwright (`/opt/node-tools/node_modules/playwright`). Wait for `networkidle` before interacting: Vite reloads the page the first time it optimizes dependencies.
- To seed test mail, create an `mbox_import` source with `providerConfig.localFilePath` pointing at an mbox file you wrote; the ingestion worker imports it. Duplicates or other edge cases are easiest to add afterwards with SQL.
- A source page's index coverage (`IngestionStats.indexedCount`) counts rows with `is_indexed = true` in Postgres. It is not read from Meilisearch, so deleting a Meilisearch document does not lower it; set `is_indexed = false` to simulate unindexed mail.

Known environment quirks:

- **`xlsx` install failure:** the backend depends on `xlsx` from `cdn.sheetjs.com`, which the sandbox proxy may block (403). For a local-only install, temporarily add `pnpm.overrides.xlsx = "0.18.5"` to the root `package.json`, run `pnpm install --no-frozen-lockfile`, then restore `package.json` and `pnpm-lock.yaml`. Never commit that override. The session-start hook does this for you; repeat it by hand only if you reinstall later.
- **Types build emits nothing:** `packages/types` is a composite (incremental) build. If `dist/` is gone but `tsconfig.tsbuildinfo` remains, `tsc` decides nothing changed and writes nothing. Delete the `.tsbuildinfo` and build again.
- **`dump.rdb` in the repo:** `redis-server` writes its snapshot into its working directory. Start it from `/tmp` with `--save ""`, as the hook does; delete a stray `dump.rdb`, never commit it.
- **Stopping a server:** `pkill -f <pattern>` also matches the shell running the command when that command line contains the pattern, and kills it (exit code 144). Find the PID with `ps -eo pid,comm,args` filtered on `comm` instead.
- **Drizzle schema drift:** the schema doesn't declare four `journaling_sources` columns that migration 0042 added (they are probably used by enterprise). `db:generate` will try to `DROP` them. Delete those statements from any new migration and keep the snapshot's `journaling_sources` columns as they were.
- **VitePress templates:** the docs are Vue templates, so `{{ … }}` in inline code (a `docker inspect --format '{{json .Mounts}}'`, say) fails the docs build. Put it in a fenced code block.
- **Formatting:** prettier formats JSON with tabs. Some committed files (`openapi.json`, migration meta, a few Svelte pages) were never prettier-clean upstream, so only format files you create or substantially rewrite, or files that were already clean. To check whether a file was clean before your change: `git show HEAD:<path> | npx prettier --check --stdin-filepath <path>`.

## Backend conventions

- **Routes** (`src/api/routes/*.routes.ts`):
    - every endpoint has an `@openapi` JSDoc block, which `pnpm docs:gen-spec` turns into the spec; commit the regenerated `docs/api/openapi.json`
    - the blocks are YAML: a colon followed by a space inside a description (`the same email: rows…`) breaks the block. The generator only prints a `YAMLSemanticError` and leaves the endpoint out of the spec, so check its output, or that the path count rose
    - routes that act on one record use `requirePermission(action, subject, { loadResource })`, so IAM conditions are evaluated against the record
    - long-running work returns `202` and runs as a job; responses include `workerAlive` from `isIndexingWorkerAlive()` so the UI can warn when no worker is running
- **Controllers** return `{ message }` bodies with `req.t(...)` strings. Refusals that a client may want to branch on also carry a machine-readable `reason`.
- **i18n:** new strings go in `packages/backend/src/locales/en/translation.json` and `packages/frontend/src/lib/translations/en.json`, English only, which is how upstream adds them. The frontend falls back to `en`; the backend falls back to the system's default language.
- **Comments:** upstream comments explain _why_, at length, often naming the bug or issue a line prevents. Match that density in the code you touch.
- **Deletion** always goes through `ArchivedEmailService.deleteArchivedEmail` and is gated by `ENABLE_DELETION` (`checkDeletionEnabled`). That path checks legal hold, reference-counts shared storage files and removes Meilisearch documents.
- **Destructive or maintenance jobs** use a fixed `jobId` with `claimJobId` / `isJobLive`, and `attempts: 1`.
- **Job progress and logs:** both workers wrap their processor in `withJobLog`, so every job logs its start and its result or error to its BullMQ log, which the Jobs page shows. Long jobs should also report `job.updateProgress(...)` and log one line per phase, not per batch. Don't rely on a finished job's record to report its outcome later: the indexing worker keeps only the last 100 finished jobs across the whole queue, so a long import pushes a finished job out within seconds. Store the outcome yourself, as `MailboxMergeService.recordRun` does in Redis.
- **Job controls** (Jobs page and `/v1/jobs/...`): only failed indexing jobs can be retried (an ingestion job belongs to a sync cycle; use Force Sync), and only finished jobs can be removed. A running job can't be stopped. Keep it that way unless the job type is known to be safe.

## Domain model essentials

- **Ingestion sources and merge groups:** a source can be merged into a root source. All of a group's emails, attachments and storage are owned by the root: rows carry the root's `ingestion_source_id`, and paths are `{openArchiverFolderName}/{rootId}/emails/...`. Group-scoped queries use `IngestionService.findGroupSourceIds` and `groupScopeFilter`.
- **Mailbox** = `archived_emails.user_email`, always compared normalized (`lower(btrim(...))`, `normalizeEmailAddress`, `matchesMailbox`). Not every mailbox identity is an email address (IMAP logins, PST folder names).
- **Dedup** in `IngestionService.processEmail` runs three gates:
    1. this mailbox already has the Message-ID, so skip
    2. another mailbox of the group has it, so add a row that shares the stored file
    3. otherwise store a new file

    Preserve-original (GoBD) sources also dedup on a content hash.

- **Mailbox merge** (this fork):
    - progress: `GET /v1/ingestion-sources/{id}/mailboxes/merge-status`, shown at the top of the source page by `MailboxMergeProgress.svelte`
    - `mailbox_aliases` (keyed on the group root, kept flat) maps a provider mailbox to a canonical one, and ingestion resolves it before the dedup gates
    - moved rows remember the provider mailbox in `archived_emails.original_user_email`, and unmerge moves them back
    - code: `MailboxMergeService`, `helpers/mailboxAlias.ts`, the `merge-mailboxes` and `unmerge-mailbox` jobs; docs: `docs/user-guides/email-providers/merging-mailboxes.md`
- **Protected rows** must never be removed by maintenance: rows under an active legal hold, with a retention label, or journaled (see `ArchiveMaintenanceService.#protectedRow`).
- **Search** documents in Meilisearch are keyed by email id and built from the DB row. After changing indexed fields on a row, set `is_indexed = false` and enqueue `index-email-batch`; the reconcile job catches anything missed.
- **IAM:** CASL policies can be conditioned on fields such as `userEmail`, so moving mail between mailboxes changes who can see it.

## Frontend conventions

- Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`). Pages load data in `+page.server.ts` with `$lib/server/api`; client-side calls use `$lib/api.client` (`api('/path', init)`, prefixed with `/api/v1`).
- Use the existing shadcn-svelte components in `src/lib/components/ui/` (generated files that prettier ignores) and put custom components in `src/lib/components/custom/`. Show feedback with `setAlert(...)`, and call `invalidateAll()` after mutations that change loaded data.
- All text goes through `$t('app.…')`, including pluralization-free wording (there is no plural support, so avoid "1 emails" phrasings).
- Ingestion-source actions used on more than one page (force sync, reindex) live in `$lib/ingestionActions.ts`, which also reports their outcome. Link to a filtered search with its `searchUrl({ from, to, mailboxes, sources })`; the search page reads those filters from the URL and shows them in its filter panel. Scope `sources` to the merge group's root, since a child's mail is indexed under the root's id.
- A component that calls `api()` as soon as it mounts can go out without a token: the root layout passes the session token to `authStore` in an effect, and Svelte runs a child's mount before its parent's effects. Wait for `$authStore.accessToken` first, as `JobsSummaryCard.svelte` does.
- layerchart `BarChart` (band tooltip mode) lays transparent full-width tooltip rects over the bars, so `onBarClick` never fires. Use `onTooltipClick`.
- Don't set `disabled` on a bits-ui `DropdownMenu.Item` from state its own `onclick` changes: the item disables itself mid-click, the menu stays open and the page stops taking clicks. Ignore repeat clicks inside the handler instead.
- For UI/UX work, check the result in a real browser at desktop and phone widths and look at the screenshots before calling it done.

## MCP server (planned)

Not built yet. The agreed plan and a handoff for whoever builds it are in `.claude/plans/mcp-server.md`. Intended shape, unless decided otherwise:

- A new workspace package (for example `packages/mcp-server`) using the official TypeScript MCP SDK.
- It talks to the REST API over HTTP with an API key (`X-API-KEY` header; keys are created in the UI or via `/v1/api-keys`), never directly to Postgres or Meilisearch. That keeps permissions, audit logging and IAM in one place, and it is why the API must stay stable.
- Tools map onto existing endpoints: search, read an archived email or thread, list sources, per-source stats, mailbox listing. Write or destructive tools (sync, merge, delete) should be opt-in and clearly labelled.
- Reuse request and response types from `@open-archiver/types`. When the MCP server needs data the API doesn't expose, add an endpoint first (with `@openapi` docs), then the tool.
