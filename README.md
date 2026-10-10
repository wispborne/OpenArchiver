> [!NOTE]
> **This is [wispborne](https://github.com/wispborne)'s fork of [Open Archiver](https://github.com/LogicLabs-OU/OpenArchiver).** It tracks upstream and adds UI and reliability work on top. Everything below the line is upstream's README, unchanged.

## About this fork

**Image:** `ghcr.io/wispborne/open-archiver`, rebuilt on every push to `main` that changes code. Tags: `latest`, `main`, and the first 12 characters of the commit SHA. Pin a SHA tag if you want to choose when you update.

**MCP server image:** `ghcr.io/wispborne/open-archiver-mcp`, same tags, rebuilt when the MCP server changes. See [MCP Server](docs/user-guides/mcp-server.md).

### Installing

The fork runs with the same `docker-compose.yml` as upstream; only the app image differs. A `docker-compose.override.yml` swaps it without editing upstream's file.

1. Clone the fork and create your `.env`:

    ```bash
    git clone https://github.com/wispborne/OpenArchiver.git
    cd OpenArchiver
    cp .env.example .env
    ```

2. Edit `.env`. At minimum:
    - set `APP_URL` (and `ORIGIN`) to the address you will open in the browser
    - change `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MEILI_MASTER_KEY` and `JWT_SECRET`
    - set `ENCRYPTION_KEY` to the output of `openssl rand -hex 32`

    `.env.example` explains the rest.

3. Point the app service at the fork's image:

    ```bash
    cat > docker-compose.override.yml <<'EOF'
    services:
        open-archiver:
            image: ghcr.io/wispborne/open-archiver:latest
    EOF
    ```

    Replace `latest` with a SHA tag to pin a version.

4. Start it, then open `APP_URL` (by default `http://localhost:3000`) and create the first admin account:

    ```bash
    docker compose up -d
    ```

To update: `docker compose pull open-archiver && docker compose up -d`.

**Switching an existing upstream install:** do step 3 in the folder that holds your `docker-compose.yml`, then `docker compose pull open-archiver && docker compose up -d`. Your data, `.env` and volumes stay as they are; the fork's migration runs on start. Back up the Postgres volume first, since going back to upstream's image afterwards is untested (see below).

**Compatibility:**

- The REST API only grows: new endpoints and new optional fields. Existing endpoints, fields and status codes behave as upstream's, so existing API clients keep working.
- The fork adds one database migration (`0045`: the `mailbox_aliases` table and an `original_user_email` column on `archived_emails`, both for mailbox merges). It runs automatically on start. Moving a database back to upstream's image afterwards is untested.

### Differences from upstream

Kept current as the fork changes. Newest first within each group.

**New features**

- **MCP server for AI assistants** (`packages/mcp-server`, image `ghcr.io/wispborne/open-archiver-mcp`). Lets Claude Code, Claude Desktop, Cursor, Open WebUI and other MCP clients search and read the archive: search, emails, threads, attachment text, sources and statistics. Read-only, and it goes through the REST API with an API key, so roles and the audit log apply. Runs over stdio or HTTP. See [MCP Server](docs/user-guides/mcp-server.md).
- **Repair attachment files** (Admin → Jobs → Maintenance). Finds attachment records whose stored file is missing, rebuilds what it can from the stored emails, reports the emails it can't fix, and gives old records with no source their email's source. See [Background Jobs](docs/user-guides/background-jobs.md#maintenance-repair-attachment-files).
- **Background jobs on the dashboard.** Super Admins see each queue's worker status and counts, and the jobs running now with their progress.
- **Jobs page redesign** (Admin → Jobs).
    - Each queue shows whether its worker is running and whether it is paused, with job counts by state.
    - A detail view for every job: progress, error and stack trace, its log, its input and its result.
    - Every job now writes log lines when it starts and ends.
    - Controls: pause and resume a queue, retry failed indexing jobs, and remove or clear finished jobs.
    - See [Background Jobs](docs/user-guides/background-jobs.md).
- **Mailbox merge progress.** A source's page shows a running merge or unmerge, step by step, and afterwards how it ended, with Retry if it failed.
- **More things are clickable.**
    - Dashboard: the totals, the storage chart and the Top Senders chart lead to their lists, sources and searches.
    - A source's page has an Actions menu (Force Sync, Reindex, Remove duplicates), Search this source, a Reindex missing button when coverage is incomplete, and per-mailbox searches.
    - An email's page has a Back link, and its sender, recipients and mailbox lead to filtered searches.
- **Remove duplicate emails** from one ingestion source (Actions menu on the source page, or the row menu on the sources list).
    - Upstream built the cleanup but shipped it switched off. The fork turns it on and adds the dialog.
    - It also fixes merge groups, which reported no duplicates, and stops it offering copies it will never remove.
    - See [Removing Duplicate Emails](docs/user-guides/removing-duplicates.md).
- **Merge two mailboxes** within an ingestion source, and unmerge them. Mail still synced from the merged mailbox lands in the target from then on. See [Merging Mailboxes](docs/user-guides/email-providers/merging-mailboxes.md).

**Fixes**

- Force Sync no longer starts a second sync of a mailbox that is still syncing. Two syncs of one mailbox could archive emails twice, and could leave the ingestion worker stuck.
- Emails containing a NUL character (seen in subjects) are archived. Before, Postgres refused them, and IMAP sync never tried them again; emails that failed that way before this fix are still missing until their mailbox is re-scanned.
- A stuck Meilisearch queue no longer grows without bound. Workers hold documents back once `MEILI_MAX_PENDING_TASKS` (default 1000) tasks are waiting. They also check on Meilisearch tasks every 500 ms instead of every 50 ms (`MEILI_WAIT_FOR_TASK_INTERVAL`). See [Search Index Stuck](docs/user-guides/troubleshooting/search-index-stuck.md).
- A rebuilt backend picks up new translations. Before, the build copied them into a nested folder, so new messages showed as raw keys. Docker images, which build from scratch, were not affected.
- Storage sizes show `0 Bytes`, not `NaN undefined`, for a source with no mail.

**API additions** (all additive)

- `GET /v1/archived-emails/{id}/content`: the email parsed on the server, with plain text (or the HTML rendered as text), optional HTML, attachments with their extracted text on request, the thread, and an optional `maxChars` limit. Same permissions and audit entry as `GET /v1/archived-emails/{id}`.
- Optional `fields`, `crop` and `cropLength` on `GET /v1/search`, to return only some attributes and short excerpts around the match instead of every body and attachment text. Without them the response is unchanged.
- `GET /v1/ingestion-sources/{id}/mailboxes/merge-status`, plus the mailbox merge endpoints (`merge-preview`, `merge`, `unmerge`, `mailbox-aliases`).
- `GET .../duplicates` (count) and `POST .../duplicates/cleanup`, per source (`/v1/ingestion-sources/{id}/…`) and for the whole archive (`/v1/ingestion-sources/…`).
- Jobs: `GET /v1/jobs/queues/{queue}/jobs/{id}` (with the job's log), job retry and remove, retry all failed jobs, clean, pause and resume.
- `GET` and `POST /v1/jobs/maintenance/attachment-repair` (status, and start).
- Optional fields: `isPaused`, `workerAlive` and `prioritized` on queues; `progress`, `ingestionSourceName`, `canRetry`, `canRemove` and `attemptsAllowed` on jobs; `alreadyRunning` on Force Sync.

**For developers**

- [`CLAUDE.md`](CLAUDE.md) describes the fork's goals, conventions and known pitfalls.
- `.claude/hooks/session-start.sh` prepares Claude Code cloud sessions.
- `.github/workflows/ghcr.yml` publishes the image, and `ghcr-mcp.yml` the MCP server's. Upstream's Docker Hub workflows are disabled in this repository.

---

# Open Archiver

[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Meilisearch](https://img.shields.io/badge/Meilisearch-FF5A5F?style=for-the-badge&logo=meilisearch&logoColor=white)](https://www.meilisearch.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-FF3E00?style=for-the-badge&logo=svelte&logoColor=white)](https://svelte.dev/)

**A secure, sovereign, and open-source platform for email archiving.**

Open Archiver provides a robust, self-hosted solution for archiving, storing, indexing, and searching emails from major platforms, including Google Workspace (Gmail), Microsoft 365, PST files, as well as generic IMAP-enabled email inboxes. Use Open Archiver to keep a permanent, tamper-proof record of your communication history, free from vendor lock-in.

## Screenshots

![Open Archiver Preview](assets/screenshots/dashboard-1.png)
_Dashboard_

![Open Archiver Preview](assets/screenshots/archived-emails.png)
_Archived emails_

![Open Archiver Preview](assets/screenshots/search.png)
_Full-text search across all your emails and attachments with advanced filters_

## Join our community!

We are committed to building an engaging community around Open Archiver, and we are inviting all of you to join our community on Discord to get real-time support and connect with the team.

[![Discord](https://img.shields.io/badge/Join%20our%20Discord-7289DA?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/MTtD7BhuTQ)

[![Bluesky](https://img.shields.io/badge/Follow%20us%20on%20Bluesky-0265D4?style=for-the-badge&logo=bluesky&logoColor=white)](https://bsky.app/profile/openarchiver.bsky.social)

## 🚀 Live demo

Check out the live demo here: https://demo.openarchiver.com

Username: demo@openarchiver.com

Password: openarchiver_demo

## Key Features

- **Universal Ingestion**: Connect to any email provider to perform initial bulk imports and maintain continuous, real-time synchronization. Ingestion sources include:
    - IMAP connection
    - Google Workspace
    - Microsoft 365
    - PST files
    - Zipped .eml files
    - Mbox files

- **Secure & Efficient Storage**: Emails are stored in the standard `.eml` format. The system uses deduplication and compression to minimize storage costs. All files are encrypted at rest.
- **Pluggable Storage Backends**: Support both local filesystem storage and S3-compatible object storage (like AWS S3 or MinIO).
- **Powerful Search & eDiscovery**: A high-performance search engine indexes the full text of emails and attachments (PDF, DOCX, etc.).
- **Thread discovery**: The ability to discover if an email belongs to a thread/conversation and present the context.
- **Compliance & Retention**: Define granular retention policies to automatically manage the lifecycle of your data. Place legal holds on communications to prevent deletion during litigation (TBD).
- **File Hash and Encryption**: Email and attachment file hash values are stored in the meta database upon ingestion, meaning any attempt to alter the file content will be identified, ensuring legal and regulatory compliance.
-   - Each archived email comes with an "Integrity Report" feature that indicates if the files are original.
- **Comprehensive Auditing**: An immutable audit trail logs all system activities, ensuring you have a clear record of who accessed what and when.

## Tech Stack

Open Archiver is built on a modern, scalable, and maintainable technology stack:

- **Frontend**: SvelteKit with Svelte 5
- **Backend**: Node.js with Express.js & TypeScript
- **Job Queue**: BullMQ on Redis for robust, asynchronous processing. (We use Valkey as the Redis service in the Docker Compose deployment mode, but you can use Redis as well.)
- **Search Engine**: Meilisearch for blazingly fast and resource-efficient search
- **Database**: PostgreSQL for metadata, user management, and audit logs
- **Deployment**: Docker Compose deployment

## Deployment

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- A server or local machine with at least 4GB of RAM (2GB of RAM if you use external Postgres, Redis (Valkey) and Meilisearch instances).

### Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/LogicLabs-OU/OpenArchiver.git
    cd OpenArchiver
    ```

2.  **Configure your environment:**
    Copy the example environment file and customize it with your settings.

    ```bash
    cp .env.example .env
    ```

    You will need to edit the `.env` file to set your admin passwords, secret keys, and other essential configuration. Read the .env.example for how to set up.

3.  **Run the application:**

    ```bash
    docker compose up -d
    ```

    This command will pull the pre-built Docker images and start all the services (frontend, backend, database, etc.) in the background.

4.  **Access the application:**
    Once the services are running, you can access the Open Archiver web interface by navigating to `http://localhost:3000` in your web browser.

## Data Source Configuration

After deploying the application, you will need to configure one or more ingestion sources to begin archiving emails. Follow our detailed guides to connect to your email provider:

- [Connecting to Google Workspace](https://docs.openarchiver.com/user-guides/email-providers/google-workspace.html)
- [Connecting to Microsoft 365](https://docs.openarchiver.com/user-guides/email-providers/imap.html)
- [Connecting to a Generic IMAP Server](https://docs.openarchiver.com/user-guides/email-providers/imap.html)

## Contributing

We welcome contributions from the community!

- **Reporting Bugs**: If you find a bug, please open an issue on our GitHub repository.
- **Suggesting Enhancements**: Have an idea for a new feature? We'd love to hear it. Open an issue to start the discussion.
- **Code Contributions**: If you'd like to contribute code, please fork the repository and submit a pull request.

Please read our `CONTRIBUTING.md` file for more details on our code of conduct and the process for submitting pull requests.
