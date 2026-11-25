---
prerequisites:
  - 0zg1/261023-basin-timeline-race
---

[0003-commit-baseline]: <benchmark/0003-commit-baseline.md>
[0003-disk-shadow]: <benchmark/0003-disk-shadow.md>
[0003-s3-latency]: <benchmark/0003-s3-latency.md>
[0003-snapshot-readers]: <benchmark/0003-snapshot-readers.md>
[0003-wal-experiments]: <benchmark/0003-wal-experiments.md>
[0003-zset-experiments]: <benchmark/0003-zset-experiments.md>
[basin]: <../../../glossary/basin.md>
[basin-timeline]: <../../../basin-timeline.md>
[commit-marker]: <../../../glossary/commit-marker.md>
[conditional-write]: <../../../glossary/conditional-write.md>
[development]: <../../../development.md>
[differential-event]: <../../../glossary/differential-event.md>
[diy/0zg1/261023-basin-timeline-race]: <../../0zg1/261023-basin-timeline-race/README.md>
[downstream]: <../../../glossary/downstream.md>
[durable-storage]: <../../../glossary/durable-storage.md>
[envbuf]: <../../../glossary/envbuf.md>
[epilogue]: <../../../glossary/epilogue.md>
[flexbuffers]: <../../../glossary/flexbuffers.md>
[flow]: <../../../glossary/flow.md>
[leader]: <../../../glossary/leader.md>
[lexidecimal]: <../../../glossary/lexidecimal.md>
[logical-frame]: <../../../glossary/logical-frame.md>
[message-schemas]: <../../../message-schemas.md>
[milestone]: <../../../glossary/milestone.md>
[mvcc]: <../../../glossary/mvcc.md>
[object-keys]: <../../../object-keys.md>
[range-manifest]: <../../../glossary/range-manifest.md>
[revision]: <../../../glossary/revision.md>
[timeline]: <../../../glossary/timeline.md>
[turso]: <../../../glossary/turso.md>
[turso-state]: <../../../turso-state.md>
[upstream]: <../../../glossary/upstream.md>
[viewpoint]: <../../../glossary/viewpoint.md>
[virtual-file-system]: <../../../glossary/virtual-file-system.md>
[wal]: <../../../glossary/wal.md>
[z-set]: <../../../glossary/z-set.md>

# Turso Reservoir VFS

Materialize the *Basin's*[~][basin] *Timeline*[~][timeline] in *Turso*[~][turso]
with 16 KiB pages, *MVCC*[~][mvcc], and portable logical changes, pinned and
configured as the *state delta reference*[~][turso-state] describes. Store the applied *Milestone*[~][milestone] and each *Flow's*[~][flow]
latest *Viewpoint*[~][viewpoint] as decimal text:

```sql
PRAGMA page_size = 16384;
PRAGMA journal_mode = mvcc;
CREATE TABLE basin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  milestone TEXT NOT NULL
);
CREATE TABLE flows (
  id TEXT PRIMARY KEY NOT NULL,
  viewpoint TEXT NOT NULL,
  revision TEXT NOT NULL
);
CREATE TABLE marker_ranges (
  flow TEXT NOT NULL,
  downstream TEXT NOT NULL,
  upstream TEXT NOT NULL,
  blob_offset INTEGER NOT NULL CHECK (blob_offset >= 0),
  content_length INTEGER NOT NULL CHECK (content_length >= 0),
  sha384 TEXT NOT NULL,
  PRIMARY KEY (flow, downstream)
);
CREATE INDEX marker_ranges_upstream ON marker_ranges(upstream);
INSERT INTO basin VALUES (1, '0');
```

Assign each new *Flow*[~][flow] a UUIDv4 *revision*[~][revision] in its first commit
transaction; retain it on later commits and recover it from captured frames.
Include it in the *Flow object-key patterns*[~][object-keys].

Materialize *Basin Timeline race's*[~][diy/0zg1/261023-basin-timeline-race] blob locations in `marker_ranges`
in the commit transaction. Its *upstream*[~][upstream] *Milestones*[~][milestone]
and *downstream*[~][downstream] *Viewpoints*[~][viewpoint] use positive
*Lexidecimal*[~][lexidecimal] text. Preserve locations for intermediate
*Viewpoints*[~][viewpoint] within a batch and verify indexed-location recovery.

Capture each transaction's logical and physical frames as a delta that, applied
to the previous state, reproduces the new rows exactly. Use crate features `fs`
and `conn_raw_api` and call `connection.set_portable_logical_changes_enabled(true)`.
Implement *DurableStorage*[~][durable-storage] by delegating to the engine and
observing `log_tx`'s serialization callback for *logical frames*[~][logical-frame].
Disable automatic checkpointing; intercept *physical WAL*[~][wal] writes before
each explicit checkpoint truncates them.

Add a file-backed copy-on-write *VFS*[~][virtual-file-system]. Pin a checkpointed
generation before the next transaction; retain overwritten pages on disk and
seal the next generation after its checkpoint. Independent SQL readers query
the pinned views while the primary advances, without rebuilding a shadow.
Release page history when readers finish. Use these views to derive prior/next
rows for the *Z-set*[~][z-set] experiment; the
*snapshot-reader measurements*[~][0003-snapshot-readers] record the procedure.

Retain a private database in a preparation worker. Allow two batches from
preparation through publication, preparing the next while one ordered S3 upload
waits. Refresh at drained boundaries; pending *conditional writes*[~][conditional-write]
arbitrate *leadership*[~][leader]. Gather bounded requests, validate their
*Viewpoints*[~][viewpoint] in order, and materialize final row values in one
transaction. Preserve every *CommitMarker*[~][commit-marker] in ordered
*EnvBuf*[~][envbuf] chunks, each containing a *FlexBuffers*[~][flexbuffers]
tuple. Append one frame-ingestion command before the final
*range manifest*[~][range-manifest]:

```cddl
; Each tuple has its own EnvBuf; append after the commitflow chunks.
ingestturso-command = command<"sts/0/databasin/ingestturso", {
  turso: { * tstr => turso-delta }
}>
```

Shared definitions such as `command` and `decimal` are in the *message schemas*[~][message-schemas].

Follow the *delta contract*[~][turso-state]; `version` identifies the Turso
build that wrote each delta.
One *DifferentialEvent*[~][differential-event] occupies one
*Milestone*[~][milestone], regardless of request count. Increasing in-flight
limits must preserve *causal publication order*[~][basin-timeline];
acknowledge all successful requests only after their event's
*conditional PUT*[~][conditional-write] succeeds. On failure or an ambiguous
reply, reject queued work and terminate. Status requests wait behind outstanding
uploads and report durable state. Defer mismatch replies until the prefix used
to calculate their expected *Viewpoints*[~][viewpoint] is durable too.

Defaults: at most 32 requests, a 2 ms collection window, and 8 MiB of combined
request data per batch. A larger individual request forms its own batch.
`BASINSYNC_BATCH_MAX` and `BASINSYNC_BATCH_WAIT_MS` tune count and waiting;
admission and the queue remain bounded, with room for two full batches
(64 requests at the default size).

Recover the complete history as in *Basin Timeline race*[~][diy/0zg1/261023-basin-timeline-race], applying
each event's deltas instead of rerunning commit SQL. Check Turso versions,
delta framing, initial-image identity, predecessor linkage, and cursors; verify
affected rows. Earlier image-delta entries remain readable, and
new events link to their actual encoded predecessor.

Keep whole-file comparisons and *logical replay*[~][logical-frame] equivalence
in tests: randomized histories, large counters, page growth, rollback, ordered
batches, races, delayed writes, lost replies, and restart recovery. Run the
*development checks*[~][development]. The earlier
*baseline*[~][0003-commit-baseline] and *experiments*[~][0003-wal-experiments]
record the procedure choices. *Weighted-row experiments*[~][0003-zset-experiments]
explore an additional reactive-query feed; *on-disk pipeline measurements*[~][0003-disk-shadow]
compare a full shadow with a persistent row cache.

At this milestone, the server uses the two-batch pipeline with its database in memory. The on-disk
*VFS*[~][virtual-file-system] remains a prototype; runtime integration and a
persistent snapshot catalog are pending. Compare serial and bounded preparation
with *added S3 latency*[~][0003-s3-latency]. Copying into *Flow*[~][flow]
*Epilogues*[~][epilogue] is deferred.
