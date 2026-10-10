---
aside: false
---

# Jobs API

Monitor and control the BullMQ job queues for asynchronous tasks such as email ingestion, indexing, and sync scheduling. Requires Super Admin (`manage:all`) permission.

There are two queues:

- **`ingestion`** — handles all email ingestion and sync jobs (`initial-import`, `continuous-sync`, `process-mailbox`, `sync-cycle-finished`, `schedule-continuous-sync`)
- **`indexing`** — handles batched Meilisearch document indexing (`index-email-batch`) and maintenance (`reindex`, `reconcile-index`, `cleanup-orphans`, `cleanup-duplicates`, `merge-mailboxes`, `unmerge-mailbox`)

Every job writes at least a start line and a finish or failure line to its log, which [Get a Job](#get-a-job) returns.

## List All Queues

<OAOperation operationId="getQueues" />

## Get Jobs in a Queue

<OAOperation operationId="getQueueJobs" />

## Get a Job

<OAOperation operationId="getJob" />

## Retry a Failed Job

Only failed jobs of the `indexing` queue. Ingestion jobs belong to a sync cycle, so retrying one on its own would leave the cycle's bookkeeping out of step; repeat a failed sync with [Force Sync](./ingestion.md#force-sync) instead.

<OAOperation operationId="retryJob" />

## Retry All Failed Jobs

<OAOperation operationId="retryAllFailedJobs" />

## Remove a Finished Job

Removing a job that has not run would leave its work silently undone, and BullMQ cannot stop a running job, so only completed and failed jobs can be removed.

<OAOperation operationId="removeJob" />

## Remove Finished Jobs

<OAOperation operationId="cleanQueue" />

## Pause a Queue

<OAOperation operationId="pauseQueue" />

## Resume a Queue

<OAOperation operationId="resumeQueue" />
