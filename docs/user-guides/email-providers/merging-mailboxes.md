# Merging Mailboxes

A mailbox merge moves every archived email of one mailbox into another mailbox of the same ingestion source. It is useful when one person's mail was archived under two addresses, such as after a rename, a domain change, or a PST import whose mailbox name doesn't match the live account.

Merging mailboxes is different from [merging ingestion sources](./merging-sources.md). Merging sources groups whole connections together. Merging mailboxes works inside one source, or inside one merge group, and combines two of its mailboxes.

## What a merge does

Merging mailbox **A** into mailbox **B**:

- Moves every archived email of A to B. The moved emails show up under B in browsing, search, statistics and exports.
- Records A as an alias of B. Mail that is still synced from A is archived under B from then on, so the merge holds after future syncs.
- Leaves stored files alone. Storage paths never contained the mailbox, so nothing on disk or in S3 moves.
- Keeps a record of where each moved email came from. That record is what makes an unmerge possible.

B does not have to exist yet. Merging into an address with no emails renames the mailbox.

Aliases are kept flat. If A was merged into B and B is later merged into C, A then points straight at C. If you merge a mailbox into an address that was itself merged away earlier, the emails go to the mailbox that address was merged into, and the merge dialog tells you so.

## How to merge two mailboxes

1. Open **Ingestions** and click the source's name to open its statistics page.
2. In **Per-mailbox breakdown**, click **Merge into…** on the mailbox you want to merge away.
3. Enter or pick the target mailbox. The dialog shows how many emails will move and how many messages both mailboxes hold.
4. Optionally tick **Remove duplicate copies** (see below), then click **Merge**.

The emails are moved by the indexing worker in the background. Each moved email is also re-indexed so that search filters on the new mailbox. The job waits about a minute before its last pass, so a sync that was already running when you merged has switched to the new mailbox before the job finishes.

## Following a merge

While a merge or unmerge runs, the source's statistics page shows it at the top: how many emails have moved, and which step it is on. The page updates by itself. When the job finishes, the same place says how many emails moved and how many duplicate copies were removed; dismiss the message once you have read it. The outcome stays available for 30 days, or until the next merge of the same source.

If the job fails, the message shows the error and a **Retry** button. Retrying is safe: emails that already moved stay where they are, and the job moves the rest. If the indexing worker stops partway, the page warns after a minute without progress. Once a worker is running again it restarts the job, which can take up to ten minutes after the crash.

The job is also listed under **Admin → Jobs**, in the indexing queue, with its log.

A merge can't start while a sync of the source is running, or while another mailbox merge or unmerge of the same source is still in progress.

## Duplicate copies

When both mailboxes received the same message, the target ends up with two copies of it after the merge. You can remove them during the merge by ticking **Remove duplicate copies**. This option:

- needs deletion to be enabled for the instance (`ENABLE_DELETION=true`) and permission to delete from the ingestion source
- keeps one copy of each message, and prefers the target mailbox's own copy
- never removes a copy that is under legal hold, has a retention label, or was journaled
- never removes a copy whose stored content differs from the copy being kept
- writes an audit log entry for every copy it removes

Leave the option off to keep both copies. You can still remove them later with [Remove duplicate emails](../removing-duplicates.md).

## Unmerging a mailbox

The source's statistics page lists merged mailboxes under **Merged mailboxes**. Click **Unmerge** next to one to undo its merge. The alias is removed, and the emails that came from that mailbox are moved back in the background. That includes emails archived from it after the merge.

Copies removed as duplicates during the merge are not restored by an unmerge, and later syncs don't bring them back either: live sources (IMAP, Google Workspace, Microsoft 365) only fetch mail that arrived since their last sync, even on **Force Sync**, and file imports (PST, EML, Mbox) don't sync at all. The copy kept in the target mailbox stays in the archive, so the message itself is not lost; after an unmerge it is listed only under the target mailbox.

## Access control

Roles whose access is limited to particular mailboxes (an IAM condition on `userEmail`) see merged emails under the target mailbox. Before you merge, check that the people who can read the target mailbox should also be able to read the mailbox being merged into it.

## Permissions

Merging and unmerging require `update` permission on the ingestion source. Removing duplicate copies also requires `delete` permission on it.
