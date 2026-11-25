[comparison]: <comparison.html>
[crc64nvme]: <../../../../../../glossary/crc64nvme.md>
[diff-results]: <diff-results.json>
[page-index]: <page-index.md>
[prolly-tree]: <../../../../../../glossary/prolly-tree.md>
[sha384]: <../../../../../../glossary/sha384.md>

# File-diff experiment

2026-11-25, Apple M2/macOS 27.0.1, Bun 1.4.5. Three sequential trials, 8 MiB
files, random bytes, 16 KiB constant-byte page runs, and zeros. Alternate policy
order. Compare identical files, one-byte overwrite/insertion/deletion, and 16 KiB
append. Each edit starts from the original root. Clear the 16 MiB node cache before
update, diff, patch retrieval and full-read comparison. No SQL, S3, network waits or
native implementation: GETs/bytes count the storage adapter.

Both policies use content-only *prolly*[~][prolly-tree] chunks with 16/64/256 KiB
minimum/target/maximum bytes and routing target 32/max 128. The isolated change adds
a boundary when a run of at least 64 equal bytes ends, after the chunk minimum.
Input pages and keys do not affect boundaries. Include framing, logical/object
*SHA-384*[~][sha384], *CRC64NVME*[~][crc64nvme], parsing and integrity validation.
Byte refinement uses 64 KiB windows. It bounds memory, not total work: poor anchors
may still require scanning most bytes. Full-read comparison downloads both versions,
then trims their common prefix/suffix; it is a baseline for these single-edit cases,
not a general multi-edit algorithm. Independently reconstruct and verify every patch.

Median one-byte insertion costs; every emitted replacement contains exactly one
byte. Update MiB counts new immutable objects, distinct from PUT calls. Full-read
MiB includes deduplication within each version; the cache is cleared between versions.

| Data | Policy | Diff ms | GETs | Read KiB | Update MiB | Full ms | Full MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| random | Gear | 6.9 | 6 | 261.3 | 0.128 | 193.0 | 16.19 |
| random | run-aware | 6.9 | 6 | 261.3 | 0.128 | 190.0 | 16.19 |
| page-runs | Gear | 41.7 | 38 | 8226.4 | 4.018 | 174.5 | 16.06 |
| page-runs | run-aware | 3.5 | 8 | 64.3 | 0.031 | 243.0 | 16.84 |
| zeros | Gear | 41.9 | 5 | 536.6 | 0.012 | 150.3 | 0.77 |
| zeros | run-aware | 43.1 | 5 | 536.6 | 0.012 | 147.3 | 0.77 |

Identical logical roots compare with zero GETs even across different storage
allocations. Random-byte edits need six GETs/about 261 KiB instead of reading
16.19 MiB. Run-aware boundaries prevent the page-run insertion from rewriting
about 4 MiB and cut diff reads from 8 MiB to 64 KiB. They increase full-file routing
costs: denser 16 KiB leaves are a tradeoff, not a universal win. Zero-run insertion
still scans a long equal suffix, although immutable chunk reuse limits downloads
to about 537 KiB. CRC is never accepted alone as proof of equality.

Explore all operations in the *comparison*[~][comparison] or inspect the *raw
trials*[~][diff-results]. The earlier *page-index experiment*[~][page-index] separates
keyed lookup/packing concerns from content diffs. A prior bounded-total refinement
returned a multi-megabyte replacement for one-byte insertion: patch bytes are a
necessary metric alongside fast metadata comparison. Windowed refinement fixes
that measured case without claiming globally minimal edits.

Recommendation: continue the run-aware content-only design as an experiment;
confidence is moderate for useful diffs, low for declaring an optimal chunker or
replacing the VFS layout. Updates still scan routing descriptors; repeated content
and incompatible policies can force linear work. No network-latency benchmark,
real database corpus, arbitrary move detection, tiny-child inlining, native port
or SyncBlock integration is established here. Tests cover source partition and
allocation independence, canonical incremental roots, old snapshots, mixed/shifted
edits, both diff directions, coarse patches, repeated/empty content and forged
logical digests; reconstruction uses an independent byte model.
