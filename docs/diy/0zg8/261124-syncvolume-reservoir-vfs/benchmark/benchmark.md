[comparison]: <comparison.html>
[cpu-1]: <cpu-1.json>
[cpu-16]: <cpu-16.json>
[kernelspace]: <../../../../glossary/kernelspace.md>
[revision]: <../../../../glossary/revision.md>
[slow-16]: <slow-16.json>
[timeline]: <../../../../glossary/timeline.md>
[trie]: <../../../../glossary/trie.md>
[turso]: <../../../../glossary/turso.md>
[volume]: <../../../../glossary/volume.md>
[wan-1]: <wan-1.json>
[wan-16]: <wan-16.json>

# SyncVolume VFS measurements

2026-11-24; Apple M2, 24 GiB RAM, macOS 27.0.1/APFS SSD; Rust 1.92.0,
release build, vendored *Turso*[~][turso] 0.9.0-pre.1. Three trials per case,
alternating variant order; medians below. Builds/tests did not run alongside timings.
Explore the *comparison*[~][comparison].
Raw runs: *one-page local*[~][cpu-1], *sixteen-page local*[~][cpu-16],
*one-page transport*[~][wan-1], *sixteen-page transport*[~][wan-16],
and *bandwidth-limited transport*[~][slow-16].

Compare identical SQL and the existing disk COW VFS with either full-file object
backups or a *SyncVolume*[~][volume] source beneath a sparse writable overlay.
Use 16 KiB pages, MVCC, portable logical changes, FULL synchronous mode and a
2 MiB SQL cache. The primary contains 256 rows with 12,000-byte zero-filled blobs;
its image is 4,554,752 bytes. The companion's image is 262,144 bytes. Change one
primary blob to repeated `01` bytes and update the companion's activity counter.

Immutable bodies and allocation records live on disk, retaining UUIDv4
*revisions*[~][revision]. Modeled transport adds serial per-body latency plus
`bytes / bandwidth` to GETs and PUTs; these are not live S3 measurements. Body
checksums, packing, allocation lookups and file synchronization are included in
elapsed time. Allocation-record I/O is local and excluded from object-request
counts. OS caches are warm; each trial starts with cold object/page caches.

The inline budget counts pages, not bytes; key distribution may produce smaller
groups. Cold primary opening at 25 ms/object and 20 MiB/s:

| Layout / loading | Body GETs | Bytes | Open ms | First tail-row query ms |
| --- | ---: | ---: | ---: | ---: |
| Full file | 1 | 4,554,752 | 261 | 0.23 |
| One-page / lazy | 4 | 166,704 | 142 | 66.8 |
| One-page / eager | 264 | 4,540,944 | 8,809 | 0.21 |
| Sixteen-page / lazy | 2 | 274,472 | 85.7 | 76.7 |
| Sixteen-page / eager | 19 | 4,580,104 | 947 | 0.22 |

Opening the companion is measured separately. Before warm-operation and backup
timers, explicitly materialize and compare both complete restored images; that
hydration cost is excluded from those timers. Thus lazy backup results below
assume pages have already been cached. Sixty-four warm point queries take
0.96–5.77 ms across cases; the SQL updates plus both local checkpoints take
1.02–7.22 ms. Neither phase fetches objects. Eager mode also passes an offline
read/write/checkpoint test immediately after opening.

Changed-backup times include both files, hashing, packing and object publication:

| Transport / inline budget | Full file ms | Lazy ms | Eager ms |
| --- | ---: | ---: | ---: |
| Local / 1 | 34.3 | 490 | 495 |
| Local / 16 | 36.2 | 417 | 407 |
| 25 ms, 20 MiB/s / 1 | 352 | 829 | 825 |
| 25 ms, 20 MiB/s / 16 | 351 | 671 | 657 |
| 25 ms, 2 MiB/s / 16 | 2,416 | 1,055 | 1,033 |

Full files upload 4,816,896 bytes in two PUTs. One-page packing uploads 208,008
bytes in seven PUTs; sixteen-page packing uploads 800,496 in four. Each volume
backup also fetches one directory object (~1.4 KiB). Native export still scans
and repacks every selected page, explaining the local-time penalty despite object
reuse. Initial stored-body totals are 4,816,896 bytes for full files, 4,599,072
for one-page packing, and 4,843,208 for sixteen-page packing. Zero-filled data
and this small update are a particular workload, not a general amplification bound.

Retain the full-file server path for now. The experiment proves selective
recovery and substantial transfer savings; it does not establish an end-to-end
throughput gain. Sixteen-page packing is the stronger cold-start candidate here;
one-page packing minimizes changed bytes. Investigate incremental native
*trie*[~][trie] export and bounded eager prefetch before choosing a production
packing policy. Three trials do not characterize tail latency: for example,
one-page local eager backup spans 477–707 ms, while sixteen-page eager spans
406–412 ms.

Correctness checks reconstruct exact old/new images, compare successive SQL
updates/deletes/inserts against an independent map, reopen older roots, preserve
unopened nested folders, reject corrupt bodies, retry interrupted publication,
and roll back speculative local branches without refetching touched pages.
Server *Timeline*[~][timeline] durability, *KernelSpace*[~][kernelspace] promotion, concurrent uploads, encryption
and real provider behavior remain outside these measurements.
