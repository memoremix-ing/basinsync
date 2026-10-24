[0004-backup-samples]: <data/0004-backup-samples.json>
[basin]: <../glossary/basin.md>
[commit-marker]: <../glossary/commit-marker.md>
[epilogue]: <../glossary/epilogue.md>
[flow]: <../glossary/flow.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[virtual-file-system]: <../glossary/virtual-file-system.md>

# 0004 backup overhead — 2026-10-24

Compare background copying/backups enabled and disabled through real HTTP and
S3 requests. Both modes use the on-disk *Turso*[^][turso] copy-on-write
*VFS*[^][virtual-file-system] and the two-batch server pipeline. Only durable
*Timeline*[^][timeline] publication gates client success.

Seed 1,024 *Flows*[^][flow] with 400-byte id padding outside timing. Four
independent clients each commit 128 successive 1 KiB blobs to their own
*Flow*[^][flow]. Time responses through body receipt. Keep batches at 32 requests
with a 2 ms collection window; copy at most eight independent
*Flows*[^][flow] concurrently. Exclude initial recovery, seed/copy warm-up,
and final backup drain. Verify stored snapshot checksums, final copied blobs,
and status after catching up.

Use optimized Rust 1.92, 16 KiB pages, MVCC, `synchronous=FULL`, and a 2 MiB
primary cache on an Apple M2/24 GiB macOS machine. The local go-faster/fs
endpoint shares the SSD with the primary and page history. This measures
contention as well as protocol overhead, including recovery-anchor metadata
lookups once backups exist; it is a small, warm database workload.

Median results across three rotated rounds per cohort:

| Cohort | Backup interval | Added snapshot PUT delay | Requests/s | Ack p50 / p95, ms |
| --- | --- | --- | ---: | ---: |
| Default comparison | disabled | — | 119.5 | 34.0 / 38.0 |
| Default comparison | 1,000 ms | 0 ms | 100.9 | 32.6 / 70.3 |
| Frequent comparison | disabled | — | 120.0 | 33.0 / 38.2 |
| Frequent comparison | 20 ms | 0 ms | 91.8 | 41.6 / 64.3 |
| Frequent comparison | 20 ms | 100 ms | 92.3 | 37.9 / 69.7 |

The default interval costs about 16% throughput here; frequent backups cost
about 23%. Acknowledgements do not wait for a blocked backup, but background
I/O still competes for resources. With added snapshot-upload latency, coalescing
reduced median backup submissions during the measured requests from 36 to 16.
These are saturated closed-loop clients, not a fixed-arrival-rate latency test.

The *Basin*[^][basin] publishes a *CommitMarker*[^][commit-marker] only after
all covered *Flow*[^][flow] copies reach their *Epilogues*[^][epilogue].
Retain the *environment and run samples*[^][0004-backup-samples].
