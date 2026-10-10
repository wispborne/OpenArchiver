# Background Jobs

Imports, syncs, search indexing and maintenance tasks run in the background as jobs. **Admin → Jobs** shows what they are doing and lets you step in when something goes wrong. It needs the Super Admin role.

## Queues and workers

Jobs wait in one of two queues, and each queue is worked by its own worker process:

- **Ingestion** imports files and syncs mailboxes from your ingestion sources.
- **Indexing** keeps the search index up to date, and runs maintenance: reindexing, the periodic index check, mailbox merges and duplicate removal.

Each queue's card says whether its worker is running. When it says **No worker running**, nothing in that queue moves until the worker process is started again.

The card also counts the queue's jobs by state. Click a count to see those jobs:

| State     | Meaning                                                                             |
| --------- | ----------------------------------------------------------------------------------- |
| Running   | Being worked on now.                                                                |
| Waiting   | Next in line.                                                                       |
| Delayed   | Waiting for a set time, usually before an automatic retry.                          |
| Failed    | Stopped with an error, after any automatic retries.                                 |
| Completed | Finished. Only the most recent completed and failed jobs are kept, not all of them. |

**Running now** lists every running job of both queues, with a progress bar for jobs that report progress, such as a mailbox merge. **Recent failures** lists the latest failed jobs.

The dashboard shows the same at a glance: each queue's worker status and counts, and what is running now. It refreshes by itself, and is shown only to Super Admins.

The page refreshes every few seconds while it is open. Turn **Auto-refresh** off to keep it still while you read.

## Job details

Click a job to see:

- which source it belongs to, when it was queued, started and finished, and how long it took
- its progress, while it runs
- the error and stack trace, if it failed
- its **log**: every job writes a line when it starts and when it finishes or fails, and some jobs write more, such as each step of a mailbox merge
- its input and, once finished, its result

A link to a job stays valid while the job is kept, so you can send it to someone.

## What you can do

- **Pause** a queue. Running jobs finish, but nothing new starts, including scheduled syncs, until you **Resume** it. The pause is stored with the queue and stays in place after restarts, so remember to resume.
- **Retry** a failed indexing job, or all of them at once from the queue's menu. Failed ingestion jobs can't be retried one at a time, because each belongs to a sync cycle; use **Force Sync** on the ingestion source instead.
- **Remove** a finished job, or **clear** all completed or all failed jobs of a queue. This deletes their records, logs and results only; it doesn't undo anything the jobs did.

Some things are deliberately not offered. A running job can't be stopped, because the job system has no way to interrupt one partway, and stopping, say, a merge in the middle would leave its work half done. Waiting jobs can't be removed either, because their work would then never happen: a removed sync would leave its sync cycle open for good.

## Maintenance: repair attachment files

**Check and repair**, under Maintenance on the Jobs page, walks every attachment record and checks that its stored file exists.

- **Missing files.** Attachments are normally kept only as separate files, and removed from the stored email, so a missing file usually can't be rebuilt from the archive. Where an email's stored file does still hold the attachment (preserve-original sources, and mail archived by older versions), the job rebuilds the file from it, checks it against the recorded checksum, and reindexes the email.
- **What's left over.** Everything it can't rebuild is counted, together with the number of emails affected, and listed in the job's log. Those attachments have to come back from a backup of the storage folder, or from the original mailbox.
- **Records with no source.** Records written by older versions with no ingestion source are given the source of an email that uses them. That makes them count in the source's statistics, and lets new mail reuse them instead of storing another copy.

Nothing is deleted, and the job is safe to run again. A common cause of missing files is deleting an ingestion source on an older version: shared attachments were stored in the folder of the source that first saw them, and that folder went with the source.
