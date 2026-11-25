[crc64nvme]: <../../../../glossary/crc64nvme.md>
[growth-merge-2048-1280]: <growth-merge-2048-1280.json>
[growth-merge-2048-16]: <growth-merge-2048-16.json>
[growth-merge-512-1280]: <growth-merge-512-1280.json>
[growth-merge-512-16]: <growth-merge-512-16.json>
[growth-scan-2048-1280]: <growth-scan-2048-1280.json>
[growth-scan-2048-16]: <growth-scan-2048-16.json>
[growth-scan-512-1280]: <growth-scan-512-1280.json>
[growth-scan-512-16]: <growth-scan-512-16.json>
[sha384]: <../../../../glossary/sha384.md>
[trie]: <../../../../glossary/trie.md>
[turso]: <../../../../glossary/turso.md>

# Growing-file edit merge

2026-11-25, Apple M2, macOS 27.0.1; uninstrumented release builds, three
sequential trials per case. Extend a 64-row real *Turso database*[~][turso] by
512 or 2,048 rows of 12,000 bytes; retain 16 KiB pages, MVCC, FULL sync and the
companion database. Requested-file eager loading and verification precede the
backup timer. Publication includes incremental construction, *CRC64NVME*[~][crc64nvme],
encoding, *SHA-384*[~][sha384], and durable disk-adapter writes. Reopen both databases
and compare complete images after each timed publication; verify old snapshots too.

Hold the stack-head cache policies, allocation indexes and other review fixes constant.
Compare the previous per-edit linear scan (from `836c9d93`) with one sorted merge
of exposed *trie rows*[~][trie] and edits, retaining untouched opaque subtries.
Use one file worker, one PUT slot, no GET prefetch, a 128 MiB encoded disk cache,
and no modeled network delay/bandwidth cap. The benchmark's `--append-rows` option
selects growth; the existing overwrite remains present. Variant order alternates
between packing cases. This is a disk-adapter measurement, not S3/server throughput.

Median backup milliseconds:

| Appended rows | Inline budget | Scan | Merge |
| ---: | ---: | ---: | ---: |
| 512 | 16 | 887.9 | 868.9 |
| 512 | 1,280 | 96.4 | 94.8 |
| 2,048 | 16 | 3184.2 | 3107.5 |
| 2,048 | 1,280 | 336.1 | 327.9 |

The roughly 2% median differences do not establish a material throughput gain:
filesystem noise is visible, including a 753 ms merge trial in the last case.
Both implementations issue identical PUT counts/bytes and no backup GETs. The
merge removes the quadratic per-edit lookup term; it does not make the complete
export linear or avoid serializing changed objects.

Raw trials: *512/16 scan*[~][growth-scan-512-16], *merge*[~][growth-merge-512-16];
*512/1,280 scan*[~][growth-scan-512-1280], *merge*[~][growth-merge-512-1280];
*2,048/16 scan*[~][growth-scan-2048-16], *merge*[~][growth-merge-2048-16];
*2,048/1,280 scan*[~][growth-scan-2048-1280], *merge*[~][growth-merge-2048-1280].
