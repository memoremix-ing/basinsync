[0003-portable-prior-rows]: <0003-portable-prior-rows.md>
[0003-snapshot-readers-samples]: <data/0003-snapshot-readers-samples.gz>
[0003-snapshot-readers-summary]: <data/0003-snapshot-readers-summary.json>
[basin]: <../glossary/basin.md>
[flow]: <../glossary/flow.md>
[logical-frame]: <../glossary/logical-frame.md>
[mvcc]: <../glossary/mvcc.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[virtual-file-system]: <../glossary/virtual-file-system.md>
[wal]: <../glossary/wal.md>
[z-set]: <../glossary/z-set.md>

# 0003 snapshot readers — 2026-10-24

Compare two alternatives to *native prior-row metadata*[^][0003-portable-prior-rows].
Both query old/new SQL views for affected row identities observed during commit,
folding their differences into *Z-sets*[^][z-set]. Neither needs a second database
copy or application-specific knowledge of *Flow*[^][flow] cursors.

**Copy-on-write:** the *VFS*[^][virtual-file-system] pins the fully checkpointed
main-file generation and size.
Before overwriting a page, save its original 16 KiB payload to disk once per
generation. An immutable view resolves each page to the first saved overwrite at
or after its generation, falling back to the current base file. Preserve truncated
extents too. Seal the next generation after checkpoint completion. Independent,
read-only SQL connections query these views while primary writes and truncating
checkpoints continue. No database rebuilding or replay into a shadow is involved.
Released versions free reusable history slots. Page payloads are on disk; a
bounded version index and pin counts are in RAM.

**Rolling native transactions.** Start `BEGIN CONCURRENT` and read to establish
each *Turso*[^][turso] snapshot; retain successive before/after transactions until
the worker finishes querying them. Writes continue, but ordinary truncating
checkpoints return `Busy`. Experimental passive *MVCC*[^][mvcc] checkpoints
preserve the views while materializing pages into the *WAL*[^][wal]. Drain readers
and truncate every 32 batches to bound retained logs; both benchmark paths use
this drain interval. Keeping a rolling reader continuously would prevent normal
*WAL*[^][wal] rotation.

## Measurements

Median *Flow*[^][flow] updates/s; 32 per batch plus the *Basin*[^][basin] cursor:

| Stored row | Admission limit | Copy-on-write *VFS*[^][virtual-file-system] | Rolling transactions |
| --- | ---: | ---: | ---: |
| Narrow | 1 | 17,804 | 20,255 |
| Narrow | 4 | 29,590 | 31,799 |
| Extra 1 KiB blob | 1 | 9,766 | 11,086 |
| Extra 1 KiB blob | 4 | 15,212 | 14,007 |

At limit four, the copy-on-write history pool reaches 0.61 MiB narrow and
1.06 MiB wide. Rolling readers retain up to 6.51/16.67 MiB of *WAL*[^][wal]
between drains and 1,057 engine row versions at sampled boundaries; the
copy-on-write path samples zero engine row versions after its full checkpoints.
The latter still creates transient *WAL*[^][wal] files, omitted by end-of-batch
size sampling. These figures exclude the shared primary file and engine caches.

Optimized Rust 1.92.0; Apple M2/24 GiB, shared SSD and warm filesystem caches;
pinned *Turso*[^][turso] `032f5bb2c7e74107f7ef9b66d576312379000a88`.
Three alternating rounds, 8,192 *Flows*[^][flow], eight warmup and 64 measured
batches; one queued batch plus an admission bound of one/four. Every connection
has a 2 MiB page-cache budget. Primary pages are 16 KiB, `synchronous=FULL` with
default plain `fsync`. Copy-on-write history is rebuildable scratch storage and
is not separately synchronized. Throughput includes final reader drain and
checkpoint; initialization, final folding and reopen verification are excluded.
There is no S3 publication or *Timeline*[^][timeline] encoding in these runs. Do not compare
these numbers directly with full-hardware-flush or unoptimized experiments.
Retain the *raw samples*[^][0003-snapshot-readers-samples] and
*environment and summary*[^][0003-snapshot-readers-summary].

## Confidence and next boundary

All 24 runs verify every view's before/after prefix, fold emitted changes to the
final SQL relation, and reopen the final database. Delayed-reader tests compare
SQL state at every prefix and prove bounded overlap. Additional tests cover
overflow records, page reuse, partial writes, growth, truncation,
multiple generations and history-slot reuse. Small rate differences on this
shared host do not establish a universal winner.

The *VFS*[^][virtual-file-system] prototype preserves the current per-batch
physical-capture boundary. Its live snapshot catalog is not crash-persistent;
persisted roots/indexes, byte/lifetime retention bounds, encryption and failure
injection need further work. Rolling transactions use less custom storage code,
but depend on experimental passive checkpoints and need append-range capture
and restart handling for the retained *WAL*[^][wal]. Existing one-fresh-segment
physical envelopes cannot be reused unchanged. Neither prototype changes the
HTTP server or claims a complete schema-change feed. The harness currently uses
stable ordinary rowid schemas.
