[benchmark]: <benchmark.md>
[bromberg-sl2]: <../../../../glossary/bromberg-sl2.md>
[crc64nvme]: <../../../../glossary/crc64nvme.md>
[incremental]: <incremental.html>
[packing]: <packing.md>
[results]: <results.json>
[sha384]: <../../../../glossary/sha384.md>
[trie]: <../../../../glossary/trie.md>
[turso]: <../../../../glossary/turso.md>
[virtual-file-system]: <../../../../glossary/virtual-file-system.md>
[volume]: <../../../../glossary/volume.md>

# Incremental export and CRC64NVME

Explore the *comparison*[~][incremental].

Same machine, release build and *Turso workload*[~][turso] as the *baseline*[~][benchmark].
Eagerly open and verify both files before changing one primary row and the
companion counter. Compare full/incremental export independently of
*SL2*[~][bromberg-sl2]/*CRC64NVME*[~][crc64nvme]. Three sequential trials per
case; medians, milliseconds. Builds/tests did not overlap timings. The
*run index*[~][results] identifies raw profiles and I/O counts.

| Group / inline budget | *Full SL2*[~][bromberg-sl2] | *Incremental SL2*[~][bromberg-sl2] | *Full CRC*[~][crc64nvme] | *Incremental CRC*[~][crc64nvme] |
| --- | ---: | ---: | ---: | ---: |
| 4.82 MB / ordinary 1,280 | 394.7 | 382.4 | 68.9 | 76.9 |
| 4.82 MB / experimental 16 | 410.9 | 127.2 | 86.6 | 80.0 |
| 4.82 MB / experimental 1 | 494.8 | 144.6 | 159.6 | 144.1 |
| 34.18 MB / ordinary 1,280 | 2,824.4 | 476.4 | 170.2 | 112.5 |

Ordinary packing puts the small file's pages in one object, so path-copying has
little to reuse there. The larger file spans multiple objects: incremental export
reuses untouched *trie branches*[~][trie] and their summaries. Small budgets were
experimental overrides; they are not inherent to the VFS. See the *packing
shapes*[~][packing].

For the larger CRC case, full export makes eleven allocation callbacks;
incremental export makes four. Both upload the same four changed objects,
8,669,016 bytes: the old path already avoided duplicate body uploads. Whole-file
backups upload 34,177,024 bytes and take about 115 ms locally. The VFS now avoids
recreating unchanged branches and their allocation checks too.

CRC byte hashing takes under a millisecond. The initial generic combine call
recreated polynomial operators repeatedly, costing 451 ms in the large full
case. Preparing the 64 zero-byte shift powers once cuts combination to 0.3 ms
and full CRC export from 624 to 170 ms. Reference-combine tests cover every length
bit, empty inputs and `u64::MAX`; canonical roots and complete-file checksums
match independent full rebuilds.

Fresh writer contexts fetch old encoded objects during incremental editing.
With modeled 25 ms/request and 20 MiB/s transport, the large CRC case takes
813 ms for full versus 1,296 ms for incremental export. Reusing the mount's
existing 16 MiB/128-body cache reduces those to 770/952 ms. Incremental export
still misses one 4.20 MB object; the full path already has all raw database pages
locally. New published bodies enter that same bounded cache. Raw page caching
remains on disk. Whole-file backup takes 1,821 ms in this transport model.

Prefer CRC for this experiment's file summaries; retain *SHA-384*[~][sha384]
object integrity. Incremental export wins CPU work and transfer granularity,
but choosing between it and full CRC export depends on local page/object
availability and transport cost. These are disk-backed adapter measurements,
not live S3 or running-server throughput measurements.

The *VFS*[~][virtual-file-system] retains prior pins and proves page provenance before selecting deltas;
otherwise it safely rebuilds the file. Recovery, future writes behind a pinned
snapshot, retries, no-ops, truncation, growth, long compressed prefixes and
packing boundaries are checked. Server integration remains deferred. Retained
file cursors and database-reference prefetch are separate future work; this
change does not parse Turso pages to predict reads.
