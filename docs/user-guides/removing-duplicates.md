# Removing Duplicate Emails

Older versions of Open Archiver could archive the same message twice in one mailbox. When two sync cycles ran over a mailbox at the same time, both checked for the message, neither found it, and both stored it. The overlap is fixed, but copies archived before the fix stay in the archive until you remove them. They show up as the same email listed twice, and as sources covering the same mailbox reporting different email counts.

**Remove duplicate emails** finds and removes those extra copies for one ingestion source.

## What counts as a duplicate

Two archived emails are copies of each other when they are in the same mailbox of the same source and carry the same `Message-ID`. Mailbox addresses are compared ignoring case and surrounding spaces, the same way ingestion compares them.

The same message in two different mailboxes is not a duplicate: each mailbox received it, and both entries stay. To combine two mailboxes, see [Merging Mailboxes](./email-providers/merging-mailboxes.md).

## What is kept

For each message, one copy always stays. The cleanup:

- keeps a copy that is under legal hold, has a retention label, or was journaled; if any copy of a message has one of these, every copy of that message is left alone
- otherwise keeps the copy archived from the mailbox it is in, ahead of one a mailbox merge moved there, so a later unmerge doesn't take a mailbox's only copy away
- otherwise keeps the earliest archived copy
- removes a copy only when its stored content is identical to the copy being kept; two emails that share a `Message-ID` but differ in content are both left in place
- leaves stored files and attachments alone, because the copies share them with the copy being kept

Each removal goes through the normal deletion path, so it is written to the audit log and removed from search.

## How to remove duplicates

1. Open **Ingestions**.
2. Either click **⋯** on the source's row and choose **Remove duplicate emails**, or open the source's statistics page and choose **Actions → Remove duplicate emails**.
3. The dialog counts the source first. It shows:
    - **Extra copies found**: what the cleanup will remove
    - **Emails affected**: how many distinct messages those copies belong to
    - **Kept because the content differs** and **Kept by legal hold, retention label or journaling**, when there are any
4. Click **Remove duplicates**.

The cleanup runs in the background on the indexing worker. Reload the statistics page to watch the email count drop. If the dialog says no worker is processing the queue, the cleanup is queued and starts once an indexing worker is running.

Only one cleanup runs at a time across the whole instance. Starting one while another is running joins the running one rather than starting a second.

## Merge groups

If the source is part of a merge group, the cleanup covers the whole group, because all of the group's mail is stored under its root source. The dialog says so when this applies. The **⋯** menu offers the action only on the group's root row for the same reason.

The cleanup refuses to start while a mailbox merge or unmerge is running on the source. Wait for it to finish and try again.

## Requirements

- Deletion must be enabled for the instance: `ENABLE_DELETION=true` (see [Installation](./installation.md)). Without it the dialog explains that removal is disabled, and nothing is removed.
- You need `delete` permission on the ingestion source.

Removed copies are deleted permanently. The copy that is kept is the same message, so nothing is lost from the archive, but the removal itself can't be undone.

## API

The dialog uses two endpoints, which API clients can call directly:

- `GET /v1/ingestion-sources/{id}/duplicates` returns the counts.
- `POST /v1/ingestion-sources/{id}/duplicates/cleanup` queues the cleanup and answers `202`.

See the [Ingestion API](../api/ingestion.md#count-duplicate-emails) for the full request and response shapes.
