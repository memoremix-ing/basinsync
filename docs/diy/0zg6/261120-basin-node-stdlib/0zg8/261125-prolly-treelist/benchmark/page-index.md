[crc64nvme]: <../../../../../../glossary/crc64nvme.md>
[page-index-comparison]: <page-index-comparison.html>
[prolly-tree]: <../../../../../../glossary/prolly-tree.md>
[results]: <results.json>
[sha384]: <../../../../../../glossary/sha384.md>
[trie]: <../../../../../../glossary/trie.md>

# Client page-index experiment

2026-11-25, Apple M2/macOS 27.0.1, Bun 1.4.5. Three sequential trials for each
of five layouts and two datasets: 2,048 fixed 16 KiB pages (32 MiB), or variable
0–16 KiB pages (about 16 MiB). Stable, gapped, increasing Lexidecimal keys permit
middle insertion without renumbering existing pages. No SQL, S3 or network waits;
include framing, hashing, aggregation and in-memory storage in construction/export.
Clear the 16 MiB node cache before each cold lookup/range and edit.

Compare the ordinary *trie*[~][trie], a strict weighted 16-page inline budget, and
*prolly*[~][prolly-tree] boundary targets 8/16/32. Prolly defaults: minimum four
pages, maximum 64 pages/1 MiB raw leaf bytes, routing target 32/max 128 children.
Targets are hash-mask intervals after the minimum, not exact mean page counts.
Separately measure construction, three point reads, four byte ranges (three
32-byte slices and one 128 KiB slice), and overwrite/append/insert/resize export.
Each mutation starts from the original root; retained prior candidates may deduplicate.
Verify every result against independent bytes outside its timer.

Median milliseconds and total I/O for the four cold ranges; point-edit exports
replace one middle page without changing its size. New MiB counts immutable object
allocations, distinct from storage-adapter PUT calls.

| Data | Layout | Range ms | GETs | Read MiB | Edit ms | New MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| fixed | trie-1280 | 11.6 | 7 | 14.05 | 54.7 | 4.01 |
| fixed | trie-16 | 2.2 | 7 | 1.28 | 381.1 | 0.35 |
| fixed | prolly-8 | 4.1 | 12 | 1.04 | 11.8 | 0.34 |
| fixed | prolly-16 | 3.6 | 12 | 1.35 | 10.6 | 0.45 |
| fixed | prolly-32 | 4.3 | 12 | 2.55 | 14.9 | 0.87 |
| variable | trie-1280 | 7.7 | 8 | 8.15 | 33.1 | 2.04 |
| variable | trie-16 | 2.2 | 9 | 1.02 | 294.1 | 0.25 |
| variable | prolly-8 | 3.7 | 13 | 0.64 | 9.9 | 0.19 |
| variable | prolly-16 | 3.0 | 12 | 0.71 | 8.8 | 0.24 |
| variable | prolly-32 | 3.2 | 12 | 1.36 | 10.0 | 0.46 |

Explore the *comparison*[~][page-index-comparison]; inspect *raw trials*[~][results].
The weighted trie currently falls back to full export: its fixed-page overwrite
reads all 32 MiB and makes 256 PUT calls, although only two objects are new. That
CPU gap is not inherent to tries. Ordinary-trie overwrite reads/writes about 4 MiB;
prolly-16 reads about 0.78 MiB and writes 0.45 MiB in three new objects.

Prolly's extra routing levels cost requests: point/range seeks usually require
three GETs versus the trie's two. Small routing entries help bandwidth but do not
remove round trips. The interactive latency/bandwidth option is a serial cost
estimate, not a measured network benchmark. Boundary spines and byte-budgeted
root/child inlining remain important follow-ups.

Recommendation: keep the current default and pursue target-16 as a candidate for
native VFS trials; confidence is moderate. Updates scan routing descriptors,
rechunk edited runs through boundary resynchronization, and retain unrelated page
objects. They are not logarithmic end to end. Hard caps can propagate changes
farther; identical page contents are not boundary entropy. This key-based design
preserves addresses on insertion only when page IDs remain stable.

Stored *SHA-384*[~][sha384] still authenticates each fetched object. Range reads
validate size/count/bounds without recombining every routing *CRC64NVME*[~][crc64nvme];
complete reads verify the root checksum. Tests compare mixed edits with canonical
full builds, independent byte ranges/checksums, old snapshots, zero-sized pages,
byte-cap lookbehind and damaged storage. The prototype is TypeScript-only and
uses leaf/branch objects without nested inlining. The reader borrows encoded blob
views internally and copies public results.
