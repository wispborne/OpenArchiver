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
