[0002-basin-timeline-race]: <0002-basin-timeline-race.md>
[0003-commit-baseline]: <../benchmarks/0003-commit-baseline.md>
[0003-wal-experiments]: <../benchmarks/0003-wal-experiments.md>
[basin]: <../glossary/basin.md>
[commit-marker]: <../glossary/commit-marker.md>
[development]: <../development.md>
[differential-event]: <../glossary/differential-event.md>
[durable-storage]: <../glossary/durable-storage.md>
[flexbuffers]: <../glossary/flexbuffers.md>
[flow]: <../glossary/flow.md>
[logical-frame]: <../glossary/logical-frame.md>
[milestone]: <../glossary/milestone.md>
[mvcc]: <../glossary/mvcc.md>
[physical-frame]: <../glossary/physical-frame.md>
[sha384]: <../glossary/sha384.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[viewpoint]: <../glossary/viewpoint.md>

# 0003 — Turso Basin state

Replace *0002*[^][0002-basin-timeline-race]'s in-memory mapping with a
*Turso*[^][turso] database named `default.turso`, materialized from the
*Basin*[^][basin]'s *Timeline*[^][timeline]. Use 16 KiB pages, *MVCC*[^][mvcc], and
*portable logical changes*[^][logical-frame]. The tables hold the applied
*Milestone*[^][milestone] and each
*Flow*[^][flow]'s latest *Viewpoint*[^][viewpoint]; counters remain decimal text:

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

Enable the `fs` and `conn_raw_api` crate features and call
`connection.set_portable_logical_changes_enabled(true)`. Disable automatic
checkpointing while capturing a transaction.

Implement *DurableStorage*[^][durable-storage] by delegating to the engine's
storage and observing
`log_tx`'s serialization callback. Retain the log header and the complete
*logical frame*[^][logical-frame], including its portable extension.
*MVCC*[^][mvcc] commits
write rows; checkpoint each staged transaction to capture changed pages as
*physical frames*[^][physical-frame].

Extend commitflow's payload, alongside its existing *CommitMarkers*[^][commit-marker]:

```ts
deltas: { turso: { [id: string]: {
  version: string;
  logical: {
    base: Uint8Array | null;
    header: Uint8Array;
    frames: Uint8Array[];
  };
  physical: {
    before: string; after: string;
    size: number;
    pages: Array<{ number: number; data: Uint8Array }>;
  };
} } }
```

Use id `default.turso` and `version`
`"0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88"`, identifying the
*Turso*[^][turso] release and revision. Reject incompatible versions before
ingestion. `base` carries the initialized database only in the first
*DifferentialEvent*[^][differential-event]; subsequent entries use `null`.
`header` is the 56-byte native log header; `frames` excludes that header.
Pages are numbered from one, sorted, and contain exactly 16,384 bytes; `size`
is the resulting file length. `before` and `after` are hexadecimal
*SHA-384*[^][sha384] checksums of the complete database images.
Encode all byte payloads as *FlexBuffers*[^][flexbuffers] blobs.

Stage updates to both tables in one transaction against a copy of the current
database. Verify that ingesting its *logical frame*[^][logical-frame] into the
same prior image and checkpointing produces the captured database bytes. Append
both deltas to the *Timeline*[^][timeline]; publish the staged database only after
winning that append.

Recover by checking the base checksum, installing the captured
*physical frames*[^][physical-frame], checking the result checksum, and opening
the database. Validate log framing and the recovered cursors against the
*DifferentialEvent*[^][differential-event]. No commit SQL runs during recovery.

Test both ingestion paths against identical prior files at every history prefix:
compare whole files, query both tables, and run `integrity_check`. Include
randomized multi-*Flow*[^][flow] batches, updates, deletions, rollbacks,
large counters, page splits,
overflow pages, truncated/corrupt frames, wrong bases, concurrent writers, and
restart after a durable append whose response was lost. Run the
*development checks*[^][development].

This stage keeps database files in memory and recovers them fully from the
*Timeline*[^][timeline]. Checkpointing and copying each transaction costs time and
space. Native logs and byte-identical replay depend on engine compatibility:
the tests use *Turso*[^][turso] revision `032f5bb2c7e74107f7ef9b66d576312379000a88`.
Portable logical metadata does not guarantee the same bytes across engine
versions. Existing entries without deltas require migration before this stage.

Record the *three-variant commit baseline*[^][0003-commit-baseline] before tuning.

Compare *WAL capture and publication experiments*[^][0003-wal-experiments].
