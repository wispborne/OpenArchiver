---
aside: false
---

# Ingestion API

Manage ingestion sources — the configured connections to email providers (Google Workspace, Microsoft 365, IMAP, and file imports). Credentials are never returned in responses.

## Create an Ingestion Source

<OAOperation operationId="createIngestionSource" />

## List Ingestion Sources

<OAOperation operationId="listIngestionSources" />

## Get an Ingestion Source

<OAOperation operationId="getIngestionSourceById" />

## Update an Ingestion Source

<OAOperation operationId="updateIngestionSource" />

## Delete an Ingestion Source

<OAOperation operationId="deleteIngestionSource" />

## Trigger Initial Import

<OAOperation operationId="triggerInitialImport" />

## Start OAuth Mailbox Authorization

Starts (or restarts) the OAuth authorization of an `oauth_mailbox` source. Serves first-time setup and re-authorization identically.

<OAOperation operationId="startOAuthMailboxAuthorization" />

## Poll a Device-Code Authorization

One poll step of an in-progress device-code authorization. Call on the interval the authorize endpoint returned, until `pending` is false.

<OAOperation operationId="pollOAuthMailboxAuthorization" />

## OAuth Callback

The browser return leg of the authorization code flow. Unauthenticated — the signed, single-use `state` parameter is the credential. Not intended to be called directly.

<OAOperation operationId="oauthMailboxCallback" />

## Pause an Ingestion Source

<OAOperation operationId="pauseIngestionSource" />

## Force Sync

<OAOperation operationId="triggerForceSync" />

## Reindex an Ingestion Source

Rebuilds the search-index documents for a source (and its whole merge group) from the archived emails already in the database — it never re-downloads or re-ingests, and it never creates duplicate documents (Meilisearch is keyed by the email ID, so re-adding upserts). Send `{"mode": "full"}` to rebuild every document, or omit it (default `missing`) to only index emails not yet in the index.

<OAOperation operationId="reindexIngestionSource" />

## Reindex All Sources

Enqueues a reindex across every ingestion source. Requires `manage:ingestion`.

<OAOperation operationId="reindexAllIngestionSources" />

## Get Index Health

Compares the number of archived emails in the database against the number of documents in the search index for a source (and its merge group). A gap means some emails are missing from search and can be repaired with a reindex.

<OAOperation operationId="getIngestionSourceIndexHealth" />

## Preview a Mailbox Merge

Reports what merging one mailbox of the source's merge group into another would do, without changing anything. `blockedReason` is null when the merge can run; otherwise it is one of `same_mailbox`, `circular`, `already_merged`, `sync_running` or `merge_running`. See [Merging Mailboxes](../user-guides/email-providers/merging-mailboxes.md).

<OAOperation operationId="previewMailboxMerge" />

## Merge Mailboxes

Records `from` as an alias of `into` and queues a job on the indexing queue that moves the archived emails. Returns `202`. Re-sending a merge whose alias is already in place finishes a merge whose job failed partway.

<OAOperation operationId="mergeMailboxes" />

## Unmerge a Mailbox

Removes the alias and queues a job that moves the emails that came from the mailbox back out. Returns `202`.

<OAOperation operationId="unmergeMailbox" />

## List Merged Mailboxes

<OAOperation operationId="listMailboxAliases" />

## Get Statistics

Read-only statistics for a source (and its merge group): email/mailbox/thread counts, storage usage (email + attachment bytes, deduplicated), index coverage, attachment and compliance counts, a per-mailbox breakdown, merge-group children, and recent activity.

<OAOperation operationId="getIngestionSourceStats" />

## Unmerge an Ingestion Source

<OAOperation operationId="unmergeIngestionSource" />
