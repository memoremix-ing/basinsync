[0003-commit-samples]: <data/0003-commit-samples.gz>
[0003-commit-summary]: <data/0003-commit-summary.json>
[0003-turso-basin-vfs]: <../diy/0003-turso-basin-vfs.md>
[durable-storage]: <../glossary/durable-storage.md>
[flow]: <../glossary/flow.md>
[logical-frame]: <../glossary/logical-frame.md>
[mvcc]: <../glossary/mvcc.md>
[sha384]: <../glossary/sha384.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>

# 0003 commit baseline — 2026-10-23

Measure the *0003 procedure*[^][0003-turso-basin-vfs] directly, excluding HTTP
form parsing, cursor lookup, leadership contention, and
*Timeline*[^][timeline] refresh reads.

- `builtin`: built-in *DurableStorage*[^][durable-storage]; retain isolated
  database copying, SQL, checkpointing, and image reading.
- `capture`: custom *DurableStorage*[^][durable-storage], including deltas,
  *logical replay*[^][logical-frame] verification, and event encoding; no S3.
- `capture-s3`: the same capture procedure plus a conditional S3 PUT.

Each process starts from identical seeded database bytes. Use 16 KiB *MVCC*[^][mvcc]
pages, portable changes, one writer, and one 4 KiB blob per transaction.
Six rounds rotate all variant orders; each discards 100 warmups and measures
500 commits. Queries and `integrity_check` verify final state; S3 runs verify
object counts and the last database *checksum*[^][sha384] outside measured intervals.

Optimized Rust 1.92.0 benchmark profile; Apple M2 (Mac14,2), 24 GiB,
eight logical CPUs;
*Turso*[^][turso] `0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88`.
S3 is local `go-faster/fs v0.15.0` with default settings over HTTP loopback.
The machine is shared, without CPU pinning. These are local procedure timings.

| *Flows*[^][flow] / image | Variant | p50 ms | p95 ms | Commits/s¹ |
| --- | --- | ---: | ---: | ---: |
| 64 / 80 KiB | `builtin` | 0.358 | 0.393 | 2,780 |
| 64 / 80 KiB | `capture` | 1.247 | 1.337 | 799 |
| 64 / 80 KiB | `capture-s3` | 24.712 | 26.614 | 42 |
| 8,192 / 432 KiB | `builtin` | 0.409 | 0.436 | 2,417 |
| 8,192 / 432 KiB | `capture` | 3.757 | 4.099 | 262 |
| 8,192 / 432 KiB | `capture-s3` | 25.976 | 28.109 | 38 |

¹ Median per-run reciprocal mean latency; percentiles pool 3,000 commits per row.
Capture events average 54,252 bytes in both workloads.

| Mean phase, `capture` only | 64 *Flows*[^][flow], ms | 8,192 *Flows*[^][flow], ms |
| --- | ---: | ---: |
| Copy/open | 0.259 | 0.290 |
| SQL transaction | 0.042 | 0.050 |
| Checkpoint | 0.032 | 0.033 |
| Read image | 0.005 | 0.021 |
| Page diff and *checksums*[^][sha384] | 0.278 | 1.497 |
| *Logical ingestion*[^][logical-frame] and verification | 0.614 | 1.868 |
| Event encoding | 0.021 | 0.025 |

Checkpointing is a small measured cost. Together, whole-image
*checksums*[^][sha384] and replay verification account for about 70% of capture
time with 64 *Flows*[^][flow], and 88% with 8,192 *Flows*[^][flow].
The S3 PUT phase averages 20.5 ms and 19.6 ms; CPU phase
timings also differ in S3 runs, so subtracting totals does not isolate PUT cost.
The capture comparison includes the full procedure, not just wrapper dispatch.

Retain the *summary and environment*[^][0003-commit-summary] and
*individual samples (gzip CSV)*[^][0003-commit-samples] for subsequent comparisons.
