[benchmark]: <benchmark.md>
[crc64nvme]: <../../../../glossary/crc64nvme.md>
[io-comparison]: <io-comparison.html>
[io-results]: <io-results.json>
[packing]: <packing.md>
[sha384]: <../../../../glossary/sha384.md>
[trie]: <../../../../glossary/trie.md>
[turso]: <../../../../glossary/turso.md>
[volume]: <../../../../glossary/volume.md>

# SyncVolume I/O and packing

Explore the *comparison*[~][io-comparison].

Same machine and real *Turso workload*[~][turso] as the *baseline*[~][benchmark],
using *CRC64NVME*[~][crc64nvme] throughout. Three sequential trials per case,
alternating variant order; 42 cases, 126 samples. Medians below are milliseconds.
Release timings disable profiling; no builds or tests overlapped timing. The *run index*[~][io-results] records every
option, raw timing and request/byte count.

The existing disk-COW VFS exports two whole files. Other rows export a
*SyncVolume*[~][volume]. Eager recovery starts with cold page/object caches;
backup follows complete-file hydration, one primary-row update and a companion
counter update. The 128 MiB encoded-object disk cache is populated by recovery,
then reused by a fresh writer context. Its contents survive process restart;
corrupt entries are discarded and refetched. Verified immutable bytes carry their
*SHA-384*[~][sha384] proof across adapter layers, with descriptor binding checked again.

34.18 MB database group, ordinary 1,280-value packing:

| Variant | Local open | Local backup | Network open | Network backup |
| --- | ---: | ---: | ---: | ---: |
| Existing whole files | 15.7 | 116.1 | 1728.0 | 1840.1 |
| Per-page pathname lookup | 172.2 | 115.2 | 2441.0 | 1314.3 |
| Resolved block cursor | 142.2 | 115.8 | 2371.5 | 1310.4 |
| Single-pass page traversal | 96.0 | 114.9 | 2246.0 | 1303.4 |
| + disk object cache | 99.1 | 118.1 | 2270.6 | 723.2 |
| + two GET lookahead slots | 132.3 | 118.3 | 2093.3 | 717.9 |
| + sibling PUT batching | 132.1 | 124.5 | 2099.9 | 724.1 |
| + two file workers | 134.4 | 103.9 | 2100.5 | 638.7 |

Network means modeled 25 ms/request and **one shared** 20 MiB/s link, including
both GETs and PUTs. Sibling batching alone finds little independent work in this
small edit; file workers overlap the primary/companion paths. Drain workers on
failure, finish child batches before their parent, and publish the common root
only after the complete group succeeds. Wall times and I/O counts cover all
workers; disabling profiling also avoids unequal recording overhead between serial and worker-thread paths.

The disk cache removes all four old-object GETs (8.67 MB) from changed backups.
A complete rebuild with the same cache and file workers takes 164.7 ms locally
and 708.6 ms over the modeled link; both exporters upload the same changed bodies.
The cache is disposable: cache files need atomic replacement and integrity checks,
not durability fsyncs. Origin object/allocation fsyncs remain enabled.

Packing is a separate choice; these are count budgets, not guaranteed group
sizes. See the *shape explanation*[~][packing]. All following rows use disk
caching, lookahead and two file workers:

| Budget | Primary-open GETs | Uploaded MB | Network open | Network backup |
| --- | ---: | ---: | ---: | ---: |
| 1,280 | 10 | 8.67 | 2100.5 | 638.7 |
| 256 | 10 | 8.67 | 2088.2 | 629.3 |
| 128 | 129 | 1.21 | 4234.7 | 265.2 |
| 16 | 131 | 0.85 | 4282.8 | 226.6 |

Smaller objects favor frequent backups; ordinary packing favors cold whole-file
recovery. Keep the choice configurable. On the 4.82 MB group, ordinary optimized
backup takes 59.4 ms locally versus 33.6 ms for whole files, and 371.9 versus
346.6 ms over the modeled link. Sixteen-value packing cuts network backup to
218.3 ms; at 2 MiB/s it takes 559.2 versus 2,421.2 ms for whole files.

Retained file cursors avoid pathname traversal without pinning idle object bodies
outside the bounded RAM cache. Eager traversal borrows page bytes directly from
verified objects; lazy reads retain selective loading. Lookahead is bounded by
request slots and half the disk-cache byte budget. It does not parse database
pages to predict references or load other files/folders.

*SHA-384*[~][sha384] remains the stored-object integrity check. Cross-language
contract vectors and writer/reader tests cover the shared checksum format;
cache corruption, restart/eviction, wrong-descriptor proofs, old snapshots,
failed parallel publication and canonical root equivalence are tested. These
are fsynced disk-adapter measurements with modeled transport, not live S3 or
running-server throughput. Three trials do not establish tail latency.
