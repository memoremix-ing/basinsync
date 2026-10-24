[0003-disk-shadow-samples]: <data/0003-disk-shadow-samples.gz>
[0003-disk-shadow-summary]: <data/0003-disk-shadow-summary.json>
[0003-zset-experiments]: <0003-zset-experiments.md>
[commit-marker]: <../glossary/commit-marker.md>
[conditional-write]: <../glossary/conditional-write.md>
[differential-event]: <../glossary/differential-event.md>
[flexbuffers]: <../glossary/flexbuffers.md>
[flow]: <../glossary/flow.md>
[logical-frame]: <../glossary/logical-frame.md>
[milestone]: <../glossary/milestone.md>
[mvcc]: <../glossary/mvcc.md>
[physical-frame]: <../glossary/physical-frame.md>
[redb]: <../glossary/redb.md>
[rust-file-sync]: <https://github.com/rust-lang/rust/blob/1.92.0/library/std/src/sys/fs/unix.rs>
[turso]: <../glossary/turso.md>
[wal]: <../glossary/wal.md>
[z-set]: <../glossary/z-set.md>

# 0003 on-disk capture pipeline — 2026-10-24

Extend the *weighted-row experiments*[^][0003-zset-experiments] with file-backed
primary state and on-disk prior-row storage. Three bounded stages overlap:

```text
primary SQL + frame capture → shadow/cache + zsets → encode + ordered S3 PUT
```

The primary can prepare later batches while earlier ones pass through capture
and publication. A request succeeds only after its combined *event*[^][differential-event]'s
*conditional PUT*[^][conditional-write]. Compare admission windows of one
(serial) and four batches; queues hold at most one batch per boundary. A slow
stage eventually applies backpressure. Separate databases avoid shared primary
locks, but still compete for the same CPU and SSD.

Compare three capture strategies:

- **None:** file-backed primary plus publication; no derived feed.
- **Full shadow:** a separate *Turso*[^][turso] database. Decode changed rowids
  from validated *logical frames*[^][logical-frame], query old rows, import the
  captured *physical WAL*[^][wal] through raw-frame insertion, query new rows,
  and checkpoint. Replayed pages reproduce the primary file exactly.
- **On-disk row cache:** *redb*[^][redb] retains native records by table/rowid.
  Read old records and replace/delete them using the captured upserts/deletes;
  commit the records and cursor in one transaction with immediate durability.

Both capture strategies emit the same decoded *Z-sets*[^][z-set]. They consult
stored rows rather than infer previous *Flow*[^][flow] cursors. Bind the final
predecessor digest in the ordered uploader, after each preceding *event*[^][differential-event]'s bytes
are known. The *Milestone*[^][milestone] identifies one atomic feed batch.

Also measure reduced durability for the derived stores, keeping the primary
fixed: shadow `synchronous=NORMAL`/`OFF`, and *redb*[^][redb]
`Durability::None`. The `OFF` variant additionally tests checkpointing every
32 batches. All state remains file-backed; reduced durability requires rebuilding
untrusted local state from the S3 prefix after a crash. Include the final
checkpoint/cache flush in pipeline-drain throughput.

## Measurements

Matched primary durability, 32 requests/batch, 1 KiB stored rows:

| Capture policy; four batches in flight | Local req/s | S3 req/s | S3 ack p50 ms | Local capture p50 ms |
| --- | ---: | ---: | ---: | ---: |
| Primary only; no feed | 772 | 648 | 89.3 | 0.00 |
| *Turso*[^][turso] FULL, checkpoint each batch | 493 | 485 | 186.1 | 54.20 |
| *Turso*[^][turso] NORMAL, each batch | 495 | 457 | 194.7 | 53.07 |
| *Turso*[^][turso] OFF, each batch | 665 | 638 | 123.4 | 17.85 |
| *Turso*[^][turso] OFF, every 32 batches | 824 | 679 | 124.2 | 4.41 |
| *redb*[^][redb] Immediate | 731 | 582 | 115.3 | 7.92 |
| *redb*[^][redb] None | 763 | 605 | 98.2 | 2.12 |

With strict full-flush settings, S3 throughput increases from 318 to 485 req/s
for the full shadow and 432 to 582 req/s for the immediate cache when the
window increases from one to four. S3 acknowledgement p50 increases from
101 to 186 ms and 74 to 115 ms, respectively. These are bounded pipeline
overlap gains, with additional queueing latency.

`NORMAL` retains checkpoint flush costs. `OFF` still pays for native *WAL*[^][wal] header
initialization when checkpointing every batch; amortizing that initialization
over 32 batches matters. Reduced capture policies run near the primary-only
S3 baseline here; differences of a few percent on this shared device are not
a reliable engine ranking. The immediate-cache and full-shadow references
come from the preceding matched-flush rounds.

The wide primary/shadow files finish at 8.80 MiB each; the persistent row cache
finishes at 16.07 MiB. Narrow files are 432 KiB and 768 KiB, respectively.
These final lengths omit peak temporary *WAL*[^][wal] growth: periodic checkpointing
can retain up to 32 batches of page frames on disk.

The main comparisons contain 72 matched-flush and 60 reduced-policy runs.
The 144-run default-flush exploration remains in the raw archive; its local
round 2 overlapped regression tests and is excluded from performance summaries.

Use matched macOS flush policies for engine comparisons. The exploratory grid
used *Turso*[^][turso]'s default plain `fsync`, while
*Rust file synchronization*[^][rust-file-sync] used by *redb*[^][redb] requests
`F_FULLFSYNC`. The matched grid enables `fullfsync=ON` for the primary and full
shadow too. It measures the default batch size of 32 requests; the earlier
single-request results retain their original, unequal flush settings.

Three rotated rounds; 8,192 *Flows*[^][flow], with either narrow rows or an
additional 1 KiB stored blob per row. Updates stride across rowids; batches
contain 1 or 32 requests with 4 KiB opaque *marker*[^][commit-marker] blobs. Each database has a
2 MiB page-cache budget. Primary and full shadow use 16 KiB pages and
*MVCC*[^][mvcc]; the primary keeps `synchronous=FULL` throughout. Shadow/cache
durability varies as described above. *redb*[^][redb] uses its default 4 KiB pages.

The matched local-publication runs measure 64 batches after 32 warmups, including a
synced file write for each *event*[^][differential-event]. S3 runs measure 256 requests after 64 warmups
against local `go-faster/fs v0.15.0`. Wall throughput runs from the last warmup
acknowledgement through pipeline drain. Latency starts at admission;
admission wait is recorded separately. Pipeline filling therefore affects
latency without counting blocked admission as preparation work.

Optimized Rust 1.92.0, Apple M2/24 GiB, one shared SSD; filesystem caches are
warm. *Turso*[^][turso] is pinned to
`0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88`;
*redb*[^][redb] is `4.4.0`, revision
`2d866285109edee332643bc6a78cecb260cd9c8d`.
Initialization, database copies, seed upload, replay verification, and readback
are outside timing. The exploratory grid used 128 measured local batches.
File sizes are logical lengths; OS caches and allocator
overhead are not included in the page-cache budgets. These are persistence and
feed-construction prototypes, not a changed HTTP server configuration.

## Correctness boundaries

Read back every stored *event*[^][differential-event], verify predecessor linkage, reconstruct the final
primary file, and fold the emitted *Z-sets*[^][z-set] from the matching seed.
The resulting relations must equal SQL state, with no retractions of absent rows.
Unit tests compare both strategies for inserts, checkpointed upserts, deletes,
duplicate values, NULL/text/real/blob values, large overflow records, rowid
changes, savepoints, and reopen. Paused publication proves bounded overlap and
S3-gated completion; a stored *event*[^][differential-event] with a lost reply leaves a recoverable
prefix and stops further publication.

These prototypes support one primary writer and stable ordinary rowid schemas;
the frame parser is pinned and unencrypted. Schema evolution and special tables
need further work. Local primary/shadow/cache state may advance beyond the S3
prefix; after failed publication, discard speculation and recover from that
prefix before accepting more work. No derived sidecar or reactive query runtime
is required: the *FlexBuffers*[^][flexbuffers] *event*[^][differential-event] contains `zsets` alongside
the logical and *physical frames*[^][physical-frame].

Retain the *environment and summary*[^][0003-disk-shadow-summary] and
*raw samples (gzip JSON)*[^][0003-disk-shadow-samples].
