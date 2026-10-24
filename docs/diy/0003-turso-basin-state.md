[0002-basin-timeline-race]: <0002-basin-timeline-race.md>
[0003-commit-baseline]: <../benchmarks/0003-commit-baseline.md>
[0003-wal-experiments]: <../benchmarks/0003-wal-experiments.md>
[0003-zset-experiments]: <../benchmarks/0003-zset-experiments.md>
[basin]: <../glossary/basin.md>
[commit-marker]: <../glossary/commit-marker.md>
[conditional-write]: <../glossary/conditional-write.md>
[development]: <../development.md>
[differential-event]: <../glossary/differential-event.md>
[durable-storage]: <../glossary/durable-storage.md>
[epilogue]: <../glossary/epilogue.md>
[flexbuffers]: <../glossary/flexbuffers.md>
[flow]: <../glossary/flow.md>
[logical-frame]: <../glossary/logical-frame.md>
[milestone]: <../glossary/milestone.md>
[mvcc]: <../glossary/mvcc.md>
[physical-frame]: <../glossary/physical-frame.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[turso-state]: <../turso-state.md>
[viewpoint]: <../glossary/viewpoint.md>
[wal]: <../glossary/wal.md>

# 0003 — Turso Basin state

Materialize the *Basin*[^][basin]'s *Timeline*[^][timeline] in *Turso*[^][turso]
with 16 KiB pages, *MVCC*[^][mvcc], and portable logical changes. Store the applied
*Milestone*[^][milestone] and each *Flow*[^][flow]'s latest
*Viewpoint*[^][viewpoint] as decimal text:

```sql
PRAGMA page_size = 16384;
PRAGMA journal_mode = mvcc;
CREATE TABLE basin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  milestone TEXT NOT NULL
);
CREATE TABLE flows (
  flow TEXT PRIMARY KEY NOT NULL,
  viewpoint TEXT NOT NULL
);
INSERT INTO basin VALUES (1, '0');
```

Use crate features `fs` and `conn_raw_api` and call
`connection.set_portable_logical_changes_enabled(true)`. Implement
*DurableStorage*[^][durable-storage] by delegating to the engine and observing
`log_tx`'s serialization callback for *logical frames*[^][logical-frame]. Disable
automatic checkpointing; intercept *physical WAL*[^][wal] writes before each
explicit checkpoint truncates them.

Retain a private database in one worker. Gather bounded requests, validate their
*Viewpoints*[^][viewpoint] in order, and materialize final row values in one
transaction. Preserve every *CommitMarker*[^][commit-marker] in an ordered
*FlexBuffers*[^][flexbuffers] vector, with one frame-ingestion command last:

```ts
[
  [Symbol.species, "sync.memoremix.com", "sts/0/databasin/commitflow", {
    markers: { [flow]: { viewpoint, sha384, blob } }
  }],
  // Further commitflow commands, including successive viewpoints of one Flow.
  [Symbol.species, "sync.memoremix.com", "sts/0/databasin/ingestturso", {
    turso: { "default.turso": { version, logical, physical } }
  }]
]
```

Use the *frame contract*[^][turso-state] and version
`0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88`.
One *DifferentialEvent*[^][differential-event] occupies one
*Milestone*[^][milestone], regardless of request count. Uploads remain ordered;
acknowledge all successful requests only after their event's
*conditional PUT*[^][conditional-write] succeeds. On failure or an ambiguous
reply, reject queued work and terminate. Status requests wait behind outstanding
uploads and report durable state.

Defaults: at most 32 requests, a 2 ms collection window, and 8 MiB of combined
request data per batch. A larger individual request forms its own batch.
`BASINSYNC_BATCH_MAX` and `BASINSYNC_BATCH_WAIT_MS` tune count and waiting;
admission and the queue remain bounded.

Recover the complete history as in *0002*[^][0002-basin-timeline-race], ingesting
*physical frames*[^][physical-frame] instead of rerunning commit SQL. Check
versions, native framing, initial-image identity, predecessor linkage, and
cursors; verify affected rows. Earlier image-delta entries remain readable, and
new events link to their actual encoded predecessor.

Keep whole-file comparisons and *logical replay*[^][logical-frame] equivalence
in tests: randomized histories, large counters, page growth, rollback, ordered
batches, races, delayed writes, lost replies, and restart recovery. Run the
*development checks*[^][development]. The earlier
*baseline*[^][0003-commit-baseline] and *experiments*[^][0003-wal-experiments]
record the procedure choices. *Weighted-row experiments*[^][0003-zset-experiments]
explore an additional reactive-query feed. Database files remain in memory; snapshots and
copying into *Flow*[^][flow] *Epilogues*[^][epilogue] are deferred.
