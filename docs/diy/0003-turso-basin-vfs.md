[0002-basin-timeline-race]: <0002-basin-timeline-race.md>
[0003-commit-baseline]: <../benchmarks/0003-commit-baseline.md>
[0003-disk-shadow]: <../benchmarks/0003-disk-shadow.md>
[0003-s3-latency]: <../benchmarks/0003-s3-latency.md>
[0003-snapshot-readers]: <../benchmarks/0003-snapshot-readers.md>
[0003-wal-experiments]: <../benchmarks/0003-wal-experiments.md>
[0003-zset-experiments]: <../benchmarks/0003-zset-experiments.md>
[basin]: <../glossary/basin.md>
[basin-timeline]: <../basin-timeline.md>
[commit-marker]: <../glossary/commit-marker.md>
[conditional-write]: <../glossary/conditional-write.md>
[development]: <../development.md>
[differential-event]: <../glossary/differential-event.md>
[durable-storage]: <../glossary/durable-storage.md>
[epilogue]: <../glossary/epilogue.md>
[flexbuffers]: <../glossary/flexbuffers.md>
[flow]: <../glossary/flow.md>
[leader]: <../glossary/leader.md>
[logical-frame]: <../glossary/logical-frame.md>
[milestone]: <../glossary/milestone.md>
[mvcc]: <../glossary/mvcc.md>
[physical-frame]: <../glossary/physical-frame.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[turso-state]: <../turso-state.md>
[viewpoint]: <../glossary/viewpoint.md>
[virtual-file-system]: <../glossary/virtual-file-system.md>
[wal]: <../glossary/wal.md>
[z-set]: <../glossary/z-set.md>

# 0003 — Turso Basin VFS

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

Add a file-backed copy-on-write *VFS*[^][virtual-file-system]. Pin a checkpointed
generation before the next transaction; retain overwritten pages on disk and
seal the next generation after its checkpoint. Independent SQL readers query
the pinned views while the primary advances, without rebuilding a shadow.
Release page history when readers finish. Use these views to derive prior/next
rows for the *Z-set*[^][z-set] experiment; the
*snapshot-reader measurements*[^][0003-snapshot-readers] record the procedure.

Retain a private database in a preparation worker. Allow two batches from
preparation through publication, preparing the next while one ordered S3 upload
waits. Refresh at drained boundaries; pending *conditional writes*[^][conditional-write]
arbitrate *leadership*[^][leader]. Gather bounded requests, validate their
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
*Milestone*[^][milestone], regardless of request count. Increasing in-flight
limits must preserve *causal publication order*[^][basin-timeline];
acknowledge all successful requests only after their event's
*conditional PUT*[^][conditional-write] succeeds. On failure or an ambiguous
reply, reject queued work and terminate. Status requests wait behind outstanding
uploads and report durable state. Defer mismatch replies until the prefix used
to calculate their expected *Viewpoints*[^][viewpoint] is durable too.

Defaults: at most 32 requests, a 2 ms collection window, and 8 MiB of combined
request data per batch. A larger individual request forms its own batch.
`BASINSYNC_BATCH_MAX` and `BASINSYNC_BATCH_WAIT_MS` tune count and waiting;
admission and the queue remain bounded, with room for two full batches
(64 requests at the default size).

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
explore an additional reactive-query feed; *on-disk pipeline measurements*[^][0003-disk-shadow]
compare a full shadow with a persistent row cache.

The server uses the two-batch pipeline with its database in memory. The on-disk
*VFS*[^][virtual-file-system] remains a prototype; runtime integration and a
persistent snapshot catalog are pending. Compare serial and bounded preparation
with *added S3 latency*[^][0003-s3-latency]. Copying into *Flow*[^][flow]
*Epilogues*[^][epilogue] is deferred.
