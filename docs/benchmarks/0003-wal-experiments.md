[0003-commit-baseline]: <0003-commit-baseline.md>
[0003-turso-basin-state]: <../diy/0003-turso-basin-state.md>
[0003-wal-samples]: <data/0003-wal-samples.gz>
[0003-wal-summary]: <data/0003-wal-summary.json>
[commit-marker]: <../glossary/commit-marker.md>
[conditional-write]: <../glossary/conditional-write.md>
[differential-event]: <../glossary/differential-event.md>
[flexbuffers]: <../glossary/flexbuffers.md>
[flow]: <../glossary/flow.md>
[logical-frame]: <../glossary/logical-frame.md>
[milestone]: <../glossary/milestone.md>
[physical-frame]: <../glossary/physical-frame.md>
[s3-conditional-writes]: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>
[sha384]: <../glossary/sha384.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[viewpoint]: <../glossary/viewpoint.md>
[wal]: <../glossary/wal.md>

# 0003 WAL and publication experiments — 2026-10-24

Extend the *baseline*[^][0003-commit-baseline] with test/benchmark prototypes;
the HTTP server retains the *0003 procedure*[^][0003-turso-basin-state].
Success follows the corresponding command's durable S3 PUT.

Capture *physical WAL*[^][wal] writes before checkpoint truncation. Validate
native checksums and commit boundaries; collect *logical frames*[^][logical-frame]
through the existing backend. Checkpoint once per transaction/batch.

| CPU procedure, p50 ms | 64 *Flows*[^][flow] | 8,192 *Flows*[^][flow] |
| --- | ---: | ---: |
| Current image comparison + replay | 1.267 | 3.787 |
| Omit shadow replay | 0.655 | 1.915 |
| WAL capture, retain image hashes/copies | 0.691 | 1.930 |
| WAL capture, copies without image hashes | 0.406 | 0.454 |
| WAL capture, persistent private database | 0.090 | 0.091 |

| Recovery, p50 ms/event; no S3 reads | 64 *Flows*[^][flow] | 8,192 *Flows*[^][flow] |
| --- | ---: | ---: |
| Current hashes + full-map checks | 0.677 | 10.759 |
| WAL frames + full-map checks | 0.662 | 9.663 |
| WAL frames + affected-row checks | 0.358 | 0.398 |

Keep engine/version, native framing/checksums, predecessor/*Milestone*[^][milestone],
*marker digests*[^][sha384], and *Viewpoint*[^][viewpoint] checks. Move shadow replay,
whole-file equality, and full-map comparisons to tests. Recovery can validate
only affected rows against the already verified prefix. Cached snapshots would
need binding to that prefix, not merely a matching integer.

Batch distinct *Flows*[^][flow] in the existing `markers` map. For repeated
*Flows*[^][flow], use an ordered *FlexBuffers*[^][flexbuffers] command vector:

```ts
[
  [Symbol.species, ns, "sts/0/databasin/commitflow", { markers }],
  // Further commitflow commands, preserving every marker and viewpoint.
  [Symbol.species, ns, "sts/0/databasin/ingestturso", { turso }]
]
```

Here `ns` is `sync.memoremix.com`; `turso` maps `default.turso` to one versioned
frame delta. Validate each transition, materialize final row values in one
transaction, and store the vector as one *DifferentialEvent*[^][differential-event].
All associated requests succeed together after its *conditional PUT*[^][conditional-write].

Pipeline one batch of CPU preparation ahead of one ordered upload. Stop and
discard speculation after failure or an ambiguous reply; never race uploads to
successive *Timeline*[^][timeline] positions. *S3's condition*[^][s3-conditional-writes]
arbitrates each object independently.

| S3, 8,192 *Flows*[^][flow]; batch requests | Serial req/s / p50 ms | Pipeline req/s / p50 ms |
| --- | ---: | ---: |
| Current, 1 | 39 / 25.9 | 53 / 38.0 |
| Distinct, 1 | 43 / 23.6 | 43 / 46.6 |
| Distinct, 8 | 342 / 24.0 | 329 / 46.8 |
| Distinct, 32 | 1,311 / 24.0 | 1,531 / 40.9 |
| One stream, 1 | 42 / 23.1 | 43 / 47.2 |
| One stream, 8 | 328 / 24.1 | 340 / 46.6 |
| One stream, 32 | 1,355 / 24.0 | 1,430 / 44.0 |

Batching dominates throughput gains. Pipelining helps the expensive current path,
but adds little after removing CPU work and raises acknowledgement latency.
Prioritize WAL capture, removing redundant replay/image scans, and batching;
keep preparation bounded. Batch collection delays are not included here.

Three rotated rounds per case; 4 KiB blobs, 16 KiB pages, 64/8,192 seeded rows;
512 CPU/recovery events or 256 S3 requests per run, plus 64 warmups. Optimized
Rust 1.92.0, Apple M2/24 GiB, local `go-faster/fs v0.15.0`; same pinned
*Turso*[^][turso] as the baseline. Rates are median per-run throughput;
latencies pool batch samples from preparation through durable acknowledgement.
Small batching/pipelining differences are exploratory on this shared machine.

Tests compare complete files after randomized replay, growth, overflow,
deletions, rollback, and ordered same-stream batches; reject corrupt/torn
*frames*[^][physical-frame], gaps and incompatible versions. Delayed PUT,
leadership loss, lost replies, disconnects and bounded speculation exercise
acknowledgements. Every measured S3 run replays all stored objects and compares
its final file outside timing. The WAL adapter currently targets synchronous
memory I/O; format/snapshot identity and public durable-versus-speculative state
need integration before replacing the server path.

Retain *environment and full results*[^][0003-wal-summary] and
*raw samples (gzip JSON)*[^][0003-wal-samples].
