# Search Index Stuck

Meilisearch works through writes as a queue of tasks. If it stops working through that queue, new mail stops appearing in search, indexing jobs fail, and the queue grows.

## Symptoms

- Indexing jobs fail with: `Meilisearch has N tasks waiting (limit 1000, MEILI_MAX_PENDING_TASKS)`. Open Archiver holds new documents back once that many tasks are waiting, so a stuck queue stops growing there instead of reaching hundreds of thousands of tasks.
- The Meilisearch log repeats an error such as:

    ```
    ERROR file_store: Can't access update file 8c1f…: No such file or directory (os error 2)
    ERROR index_scheduler: No such file or directory (os error 2)
    ```

    Meilisearch keeps each queued batch in a file until it processes it. This error means a queued task's file is gone, most often because Meilisearch was stopped while writing it. A full disk causes it too.

## Check whether it is stuck

Ask Meilisearch how many tasks are waiting, using Node inside the app container (it has no `curl`):

```sh
docker compose exec open-archiver node -e '
fetch(process.env.MEILI_HOST + "/tasks?statuses=enqueued,processing&limit=5", {
  headers: { Authorization: "Bearer " + process.env.MEILI_MASTER_KEY },
})
  .then((r) => r.json())
  .then((d) => {
    console.log("waiting:", d.total);
    for (const t of d.results) console.log(t.uid, t.status, t.type, t.enqueuedAt);
  });
'
```

Run it twice, a minute apart. If the number hasn't fallen, Meilisearch is stuck. Check free disk space as well (`df -h`).

## Fix it

None of these steps can lose email. The search index is a copy built from the database, and emails whose indexing was cancelled stay marked as not indexed, so they are indexed again afterwards.

1. In **Admin → Jobs**, **pause** the Indexing queue, so nothing new is sent while you work.
2. Cancel Meilisearch's queued tasks:

    ```sh
    docker compose exec open-archiver node -e '
    fetch(process.env.MEILI_HOST + "/tasks/cancel?statuses=enqueued,processing", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.MEILI_MASTER_KEY },
    }).then((r) => r.json()).then((t) => console.log("cancel task:", t.taskUid));
    '
    ```

    Then check again as above. The count should drop to about zero within a few minutes.

3. **If the cancel command never returns**, Meilisearch is too stuck to accept new tasks. Run `docker compose restart meilisearch` and try the cancel again right away. If that doesn't help either, rebuild the index from scratch:
    1. `docker compose stop meilisearch`
    2. Move Meilisearch's data directory, the one mounted at `/meili_data`, aside and create an empty one in its place. Keep the old one until search works again. This shows where it is:

        ```sh
        docker inspect <meilisearch container> --format '{{json .Mounts}}'
        ```

    3. `docker compose up -d meilisearch`, then `docker compose restart open-archiver`. The app creates the index and its settings when it starts.
    4. Resume the Indexing queue, then run **Ingestions → Reindex All → Full rebuild**. Search is incomplete until the rebuild finishes; follow it in **Admin → Jobs**.

4. **Resume** the Indexing queue in **Admin → Jobs**. Emails from cancelled batches are sent again, and the periodic index check picks up any that are left. Watch the Meilisearch log to confirm the error has stopped.

## Avoiding it

Stop Meilisearch cleanly. Before `docker compose stop` or `down`, pause both queues in **Admin → Jobs** and wait until nothing is running. Don't use `docker kill`. See [Background Jobs](../background-jobs.md).

## Related settings

| Variable                       | Default | Purpose                                                                                    |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `MEILI_MAX_PENDING_TASKS`      | `1000`  | Waiting Meilisearch tasks above which workers stop sending documents.                      |
| `MEILI_WAIT_FOR_TASK_INTERVAL` | `500`   | Milliseconds between checks on whether a Meilisearch task has finished.                    |
| `MEILI_LOG_LEVEL`              | `INFO`  | Meilisearch's own setting. `WARN` hides the line it logs for every request, errors remain. |
