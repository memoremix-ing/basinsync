[0003-disk-shadow]: <0003-disk-shadow.md>
[0003-portable-prior-rows-samples]: <data/0003-portable-prior-rows-samples.json>
[0003-snapshot-readers]: <0003-snapshot-readers.md>
[logical-frame]: <../glossary/logical-frame.md>
[mvcc]: <../glossary/mvcc.md>
[turso]: <../glossary/turso.md>
[virtual-file-system]: <../glossary/virtual-file-system.md>
[wal]: <../glossary/wal.md>
[z-set]: <../glossary/z-set.md>

# 0003 native prior-row experiment — 2026-10-24

An isolated *Turso*[^][turso] prototype can put prior records directly into
portable *logical frames*[^][logical-frame], eliminating the
*shadow/cache*[^][0003-disk-shadow] used to obtain them.

The commit builder already sees ended *MVCC*[^][mvcc] versions. Add a complete
`before_record` as optional length-delimited field 4 in their delete-operation
extensions. Existing upserts supply the final records; the transaction's object
map supplies table names. Unknown extension fields remain skippable, and the
recovery payload is unchanged. The prototype decoder exposes the old bytes via
`DeleteTable.record_bytes`.

Serialization alone is insufficient: a checkpointed UPSERT can overwrite a
B-tree row without retaining an ended version. Preserve that original record
as a transaction-owned deletion marker, unless it is already retained. Native
savepoint handling and commit coalescing then produce original-to-final changes,
omitting intermediate versions and transient inserts. Disabling this retention
reproduces the missing UPSERT retraction.

Fold deletes at weight −1 and upserts at +1 into *Z-sets*[^][z-set]. These are
native records: consumers still need schema information for rowid aliases,
affinity, and column interpretation. No second database or retained row cache
is required; optimized overwrites retain an extra old version until normal
checkpoint/garbage collection permits its removal.

For this experiment, portable-enabled writers opt in using transaction metadata
`turso.before_images=full/1`, set before preparing writes and fixed through commit.
Production integration should use an explicit transaction-frozen option and a
completeness indicator; require every writer to enable it. Ordinary row mutations
are the demonstrated scope. DDL, dropped-table contents, special tables, and
long-running/concurrent checkpoint behavior need further work. This is not a
statement audit feed, and it is not enabled in the basinsync server.

## Preliminary cost

Unoptimized Rust 1.88.0; file-backed 16 KiB *MVCC*[^][mvcc] primary,
`synchronous=OFF`; 4,096 seeded rows, 96 batches of 32 strided UPSERTs;
three alternating rounds. SQL construction is outside timing. No S3 writes or
derived feed encoding. Compare runtime per fixed workload, using median rates:

| Stored row | Checkpoint frequency | Additional runtime | Additional log bytes/update |
| --- | --- | ---: | ---: |
| Narrow | None during timing | 13.9% | 30 |
| Extra 1 KiB blob | None during timing | 12.3% | 1,057 |
| Narrow | Every batch | 2.2% | 30 |
| Extra 1 KiB blob | Every batch | 4.0% | 1,057 |

Wide-row logs roughly double. Checkpoint timings depend on the shared SSD;
small differences are noise. These debug measurements establish a plausible
cost, not production throughput or a ranking against optimized pipeline runs.
Retain the *raw measurements*[^][0003-portable-prior-rows-samples].

Tests reproduce missing prior rows before the change, then cover coalescing,
savepoints, rollback, UPSERT, REPLACE, rowid changes, typed/overflow records,
concurrent writes, and recovery. Folding 150 successive transactions matches
SQL state after every transaction. Seven focused tests include encrypted-log
recovery. The serial core suite passes 2,620 tests;
one checkpoint-gate test failed in the parallel run and passed in isolation
and in the serial suite. This remains an investigation limitation.

## VFS alternative

Our physical *WAL*[^][wal] recorder already wraps *Turso*[^][turso]'s file-I/O
interface, the *VFS*[^][virtual-file-system] boundary. An observation test commits
two transactions: each produces a *logical frame*[^][logical-frame], while the
database file and physical recorder remain unchanged until checkpointing.
Reading the logical-log file at this boundary exposes the existing records;
it cannot supply omitted prior values. Observing reads is insufficient too:
page-cache hits need not issue file reads.

| Approach | Obtaining prior rows | Main tradeoff |
| --- | --- | --- |
| Native portable extension | Retain ended versions at row mutation | Engine change; extra row bytes in the log |
| File-I/O/log tap | Parse existing commits and retain prior state elsewhere | Avoids engine changes; still needs the shadow/cache |
| Versioned-page *VFS*[^][virtual-file-system] | Query pinned before/after page snapshots using SQL | Avoids a full second database file; maintains page history and another reader |

The *snapshot-reader follow-up*[^][0003-snapshot-readers] implements and measures
live copy-on-write page views and rolling native read transactions. Both derive
old/new rows through SQL while the primary advances, without rebuilding a shadow.

Snapshots must include the committed *WAL*[^][wal] overlay, file length, and
schema. Copying overwritten main-file bytes alone misses newer pages in the
*WAL*[^][wal]. Bound retained history and apply backpressure when readers lag.
Current per-batch checkpoints provide candidate snapshot boundaries; coalescing
several logical commits into one checkpoint loses intermediate page snapshots
unless they are captured separately. Raw page diffing would additionally require
B-tree, overflow, page-reuse, and schema interpretation; reuse SQL readers instead.

Native prior images remain useful for a direct portable row feed. Snapshot
*VFS*[^][virtual-file-system] storage avoids the engine change and offers page
history for other readers. Physical capture and native row metadata can also
complement each other.
