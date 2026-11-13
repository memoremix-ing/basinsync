[access-token]: <../glossary/access-token.md>
[commit-marker]: <../glossary/commit-marker.md>
[conditional-read]: <../glossary/conditional-read.md>
[conditional-write]: <../glossary/conditional-write.md>
[development]: <../development.md>
[epilogue]: <../glossary/epilogue.md>
[epilogue-compaction]: <../glossary/epilogue-compaction.md>
[epilogue-protocol]: <../epilogue-protocol.md>
[etag]: <../glossary/etag.md>
[heap-protocol]: <../heap-protocol.md>
[lexidecimal]: <../glossary/lexidecimal.md>
[marking-task]: <../glossary/marking-task.md>
[milestone]: <../glossary/milestone.md>
[node]: <../glossary/node.md>
[node-promotion]: <../glossary/node-promotion.md>
[old-generation]: <../glossary/old-generation.md>
[promotion-sign]: <../glossary/promotion-sign.md>
[retainer]: <../glossary/retainer.md>
[revision]: <../glossary/revision.md>
[sweeping-task]: <../glossary/sweeping-task.md>
[timeline]: <../glossary/timeline.md>
[upstream]: <../glossary/upstream.md>
[viewpoint]: <../glossary/viewpoint.md>
[virtual-file-system]: <../glossary/virtual-file-system.md>
[young-generation]: <../glossary/young-generation.md>

# 0008 — CommitMarker edges with node promotion

Extend *commit details*[^][epilogue-protocol] with a required `edges` array;
use `[]` for an empty graph. Use the *reservation API's*[^][heap-protocol]
`{ auth: [height, version, token] }` shape, authentication, limits, and stored-target checks.
Targets may exist in either the *young*[^][young-generation] or *old*[^][old-generation]
generation. Never persist *access tokens*[^][access-token].

After verification, recheck live *revisions*[^][revision] inside the transaction
that caches *etags*[^][etag], inserts `M_` *CommitMarker*[^][commit-marker]
*retainer*[^][retainer] edges, advances the *Viewpoint*[^][viewpoint], and queues
both *sweeping*[^][sweeping-task] and *marking*[^][marking-task] tasks, unconditionally.
Commitflow records derived child ids as `edges`; rejection leaves state unchanged.

```sql
CREATE TABLE marking_tasks (
  flow TEXT NOT NULL,
  viewpoint TEXT NOT NULL,
  upstream TEXT NOT NULL,
  prioritized DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (flow, viewpoint)
);
CREATE INDEX marking_tasks_prioritized
  ON marking_tasks(prioritized, flow, viewpoint);
ALTER TABLE graph_nodes ADD COLUMN marked DATETIME NOT NULL DEFAULT '';
CREATE INDEX graph_nodes_promotion ON graph_nodes(promoted, marked);
```

Record the committing *upstream*[^][upstream] *Milestone*[^][milestone] in `upstream`,
encoded with *Lexidecimal*[^][lexidecimal].

Where staging sweeps advance breadth-first, traverse from each
*marker's*[^][commit-marker] roots depth-first. A *node*[^][node] receives its `marked` timestamp only after
all children are marked. Use bounded transaction batches; retain the
*marking task*[^][marking-task] through promotion and sign confirmation.
Compute traversal from a *VFS snapshot*[^][virtual-file-system] outside the writer,
then recheck dependencies in each transaction. `BASINSYNC_MARK_BATCH_SIZE` defaults to 256;
reuse the existing cleanup interval, task limits, and object-I/O concurrency.

The `(promoted, marked)` index queues *promotion*[^][node-promotion] where
`promoted = '' AND marked > ''`; promote children before their parents. *Conditionally HEAD*[^][conditional-read] the
*old generation*[^][old-generation]; if absent, COPY the exact
*young-generation*[^][young-generation] *revision*[^][revision] with destination
`If-None-Match: *` and source *ETag*[^][etag] matching. Verify the destination before
deleting young, then durably record `promoted`. Strongly prefer storage-side COPY;
retry failures without relaying bytes. Bounded-memory GET+PUT with
*conditional publication*[^][conditional-write] requires explicit
`BASINSYNC_PROMOTION_ALLOW_TRANSFER=true` (false by default). Keep object I/O outside the writer;
journal mutations through *Timeline*[^][timeline] ingestion frames.

Once the entire graph is promoted, conditionally create its *PromotionSign*[^][promotion-sign]
at the uncomplemented position in the same *Epilogue*[^][epilogue], recording
`x-amz-meta-upstream` as canonical decimal. Confirm presence and matching metadata before
removing the *marking task*[^][marking-task], including for empty graphs. The sign
certifies completed promotion; future *compaction*[^][epilogue-compaction] is expected to require
a contiguous available prefix of stored *marker*[^][commit-marker]/sign pairs. *Compaction*[^][epilogue-compaction]
remains for a later tutorial.

Test shared graphs, rejected edges, bounded postorder, retained versus swept branches,
slow and ambiguous COPYs, failed DELETEs, multipart fallback, restart/backup recovery,
logical/physical replay, sign confirmation failures, and mixed *Epilogue*[^][epilogue] keys. Run the *development checks*[^][development].
*Old-generation*[^][old-generation] reclamation remains for a later tutorial.
