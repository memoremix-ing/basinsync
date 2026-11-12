[commit-marker]: <../glossary/commit-marker.md>
[development]: <../development.md>
[dusting]: <../glossary/dusting.md>
[flow]: <../glossary/flow.md>
[heap-reservation]: <../glossary/heap-reservation.md>
[node]: <../glossary/node.md>
[old-generation]: <../glossary/old-generation.md>
[retainer]: <../glossary/retainer.md>
[revision]: <../glossary/revision.md>
[sweeping-task]: <../glossary/sweeping-task.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[viewpoint]: <../glossary/viewpoint.md>
[virtual-file-system]: <../glossary/virtual-file-system.md>
[young-generation]: <../glossary/young-generation.md>

# 0006 — Async shallow cleanup

Queue reclamation when committing a *Flow*[^][flow] *Viewpoint*[^][viewpoint],
leaving object deletion outside the request path. No *CommitMarker*[^][commit-marker]
edges exist yet, so every staged *node*[^][node] eventually becomes unretained.

Add a random UUIDv4 *revision*[^][revision] to each new `graph_nodes` row;
existing allocations retain theirs. Use `heap/young/${node_id}/${revision}`
and `heap/old/${node_id}/${revision}` for *young*[^][young-generation] and
*old*[^][old-generation] generation keys. Reusing a reclaimed id creates a fresh
revision: delayed DELETEs and acknowledgments must target the old *revision*[^][revision] only.
These keys disclose neither *Flow*[^][flow], *Viewpoint*[^][viewpoint], nor *Timeline*[^][timeline] position.

Extend `graph_nodes` with `revision TEXT NOT NULL` and
`freed DATETIME NOT NULL DEFAULT ''`, then add:

```sql
CREATE INDEX graph_nodes_freed ON graph_nodes(freed, id);
CREATE TABLE sweeping_tasks (
  flow TEXT NOT NULL,
  viewpoint TEXT NOT NULL,
  prioritized DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (flow, viewpoint)
);
CREATE INDEX sweeping_tasks_prioritized
  ON sweeping_tasks(prioritized, flow, viewpoint);
```

Every commit transaction inserts a *sweeping task*[^][sweeping-task] alongside
its *Viewpoint*[^][viewpoint] advancement, including intermediate commits in a batch.

A separate worker reads consistent *VFS snapshots*[^][virtual-file-system] while requests continue.
For a bounded task batch, transactionally remove the tasks and their `A_` staging
*retainer*[^][retainer] edges. Mark a *node*[^][node] `freed` with the current time only
when no *retainers*[^][retainer] remain. Bound edges processed too; retain unfinished tasks.
Reject *reservations*[^][heap-reservation] of freed *nodes*[^][node] until reclamation completes.

Journal these *Turso*[^][turso] mutations through the ordered *Timeline*[^][timeline],
using commands of this shape followed by captured frames (one phase per command):

```ts
[Symbol.species, "sync.memoremix.com", "sts/0/databasin/sweepheap", {
  tasks: Array<{ flow: string; viewpoint: string }>,
  erased: Array<{ id: string; revision: string; freed: string }>,
  freed_at: string, // UTC timestamp
  edge_limit: number
}]
```

Only after freeing is durable,
DELETE a bounded batch of exact young-generation keys. Remove their database rows
in another durable transaction only on confirmed deletion and matching *revision*[^][revision];
failures remain queued. Neither slow nor failed DELETEs should block client requests.

Tune `BASINSYNC_CLEANUP_INTERVAL_MS` (1000; zero disables),
`BASINSYNC_SWEEP_BATCH_SIZE` (16), `BASINSYNC_SWEEP_EDGE_BATCH_SIZE` (256),
`BASINSYNC_ERASE_BATCH_SIZE` (32), and `BASINSYNC_ERASE_CONCURRENCY` (4).

Test shared retainers, bounded sweeps, durable queuing, replay and snapshot recovery,
failed/lost replies, competing workers, foreground progress during DELETE,
and id reuse with a delayed old-revision DELETE. Run the *development checks*[^][development].

A later tutorial will implement a periodic *dusting*[^][dusting] job which will LIST
*young-generation*[^][young-generation] objects and check for a viable `graph_nodes`
row with matching id **and revision**. Old write URLs may recreate orphan objects;
eventual reclamation is acceptable. Defer recursive edge cleanup and old-generation deletion too.
