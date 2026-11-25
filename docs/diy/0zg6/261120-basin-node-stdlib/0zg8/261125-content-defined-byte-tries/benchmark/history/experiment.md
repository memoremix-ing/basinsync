[comparison]: <comparison.html>
[diy/0zg6/261120-basin-node-stdlib/0zg8/261125-content-defined-byte-tries]: <../../README.md>
[file-comparison-large]: <file-comparison-large.json>
[file-comparison-link]: <file-comparison-link.json>
[file-comparison-positions]: <file-comparison-positions.json>
[file-comparison]: <file-comparison.json>
[initial-diff]: <initial-diff.md>
[page-index]: <page-index.md>
[sha384]: <../../../../../../../glossary/sha384.md>
[trie]: <../../../../../../../glossary/trie.md>
[workloads]: <workloads.md>

# Candidate file-diff measurements

Historical candidate comparison; the *current tutorial*[~][diy/0zg6/261120-basin-node-stdlib/0zg8/261125-content-defined-byte-tries] selects content-defined byte tries.

2026-11-25, Apple M2/macOS 27.0.1, Bun 1.4.5. Compare keyless byte treelists with
hash-pruned *byte tries*[~][trie]. *Workload parameters*[~][workloads]. Main matrix: 864 cases, 4 MiB files, three trials,
rotating layout order. Contents: random bytes, generated JSON records, 16 KiB
constant-byte page runs, zeros. Edits: identical, one-byte overwrite, 97-byte
insert/delete, 16 KiB append, eight nearby/dispersed overwrites, 64 KiB move and
64 KiB replacement. Independently reconstruct every target from the emitted patch.

Use one ordered-anchor diff engine, 64 KiB byte-refinement windows, bounded local
edit scripts and the same 16 MiB cache/integrity rules. Clear the cache before
diffing; retain it for patch retrieval. Timers include parsing, aggregation and
hashing. Both verify stored object *SHA-384*[~][sha384]; tries prune matching physical
objects and hash loaded row bytes, while treelists also replicate logical content
identities and uniform-byte summaries. No CRC is accepted as equality proof.
This compares the implemented representations, not every possible trie summarizer.

Fixed trie chunks are 16 KiB with one-based ordinal Lexidecimal keys. Tight packing
uses a nominal 64 KiB inline budget; ordinary packing retains its existing value
budget. CDC trie and treelist use the exact same chunker: 16/64/256 KiB
minimum/target/maximum, mixed Gear plus run-transition cuts. Fixed treelist and
low-bit/mixed/run/uniform variants isolate chunking, routing and comparison changes.
Treelist routing targets 32/max 128 children. Uniform comparison can split known
runs virtually; ordinary comparison scans larger equal-length gaps in bounded windows.

Median 97-byte insertion; KiB is total diff downloads, not patch size:

| Contents | Layout | Diff ms | GETs | Read KiB | Patch B |
| --- | --- | ---: | ---: | ---: | ---: |
| random | tight fixed trie | 48.9 | 499 | 7828.5 | 97 |
| random | CDC trie | 2.9 | 8 | 436.1 | 97 |
| random | low-bit Gear | 6.5 | 4 | 170.8 | 97 |
| random | mixed Gear | 7.5 | 6 | 457.7 | 97 |
| random | mixed + runs + uniform | 8.1 | 6 | 457.7 | 97 |
| records | tight fixed trie | 43.8 | 499 | 7828.5 | 97 |
| records | CDC trie | 2.1 | 8 | 203.8 | 97 |
| records | low-bit Gear | 20.4 | 20 | 4517.0 | 97 |
| records | mixed Gear | 5.7 | 6 | 225.2 | 97 |
| records | mixed + runs + uniform | 5.7 | 6 | 225.2 | 97 |
| page-runs | tight fixed trie | 44.3 | 499 | 7828.5 | 97 |
| page-runs | CDC trie | 2.1 | 6 | 94.3 | 97 |
| page-runs | low-bit Gear | 14.4 | 22 | 4116.2 | 97 |
| page-runs | mixed Gear | 14.3 | 22 | 4116.2 | 97 |
| page-runs | mixed + runs + uniform | 4.5 | 6 | 67.1 | 97 |
| zeros | tight fixed trie | 4.6 | 6 | 91.2 | 194 |
| zeros | CDC trie | 14.7 | 9 | 782.2 | 97 |
| zeros | low-bit Gear | 16.1 | 5 | 526.3 | 97 |
| zeros | mixed Gear | 16.0 | 5 | 526.3 | 97 |
| zeros | mixed + runs + uniform | 2.0 | 2 | 263.1 | 97 |

The initial low-bit Gear rule often reaches forced 256 KiB cuts on record text.
Mixing its hash fixes that measured distribution; run-transition cuts independently
help constant-byte pages. Tight packing alone makes small reads cheap but does not
preserve fixed chunks after an unaligned insertion. CDC trie is competitive with
keyless routing: chunking explains much of the improvement. A small overwrite can
favor the tight fixed trie: random midpoint comparison reads 94 KiB versus 458 KiB
for the mixed treelist. Uniform summaries reduce zero-file dispersed-edit downloads
to 264 KiB, with an eight-byte patch. Bounded local refinement produces eight-byte
patches for the scattered-write cases even when structural anchors fail.

A *12-location sweep*[~][file-comparison-positions] checks midpoint sensitivity:
240 additional cases over random/record files, one timing trial per location.
Median random insertion downloads are 312 KiB for low-bit Gear, 208 KiB for mixed,
187 KiB for CDC trie and 8,035 KiB for tight fixed trie. Record insertion falls from
2,214 KiB to 262 KiB with mixed Gear; CDC trie uses 265 KiB. These locations broaden
coverage within two generated files, not across a real-world corpus.

The *large-edit control*[~][file-comparison-large] inserts/removes 128 KiB. Fixed
16 KiB chunks realign after these edits: random insertion takes 29 GETs/298 KiB for
the tight trie, versus 499 GETs/7,829 KiB for a 97-byte insertion. Alignment matters;
a larger edit can be cheaper to discover. The treelist uses eight GETs/564 KiB.

The *modeled link*[~][file-comparison-link] adds an actual 25 ms wait per GET and a
shared 20 MiB/s transfer queue, capped at four active GETs; 72 cases, three trials.
These are adapter measurements, not live S3 results. `multi` means eight dispersed
one-byte overwrites. Not every workload favors the treelist:

| Contents | Edit | Layout | Diff ms | GETs | Read KiB |
| --- | --- | --- | ---: | ---: | ---: |
| random | insert | ordinary trie | 506 | 2 | 8204.0 |
| random | insert | tight fixed trie | 5872 | 499 | 7828.5 |
| random | insert | CDC trie | 131 | 8 | 436.1 |
| random | insert | mixed + runs + uniform | 111 | 6 | 457.7 |
| records | insert | ordinary trie | 495 | 2 | 8204.0 |
| records | insert | tight fixed trie | 5815 | 499 | 7828.5 |
| records | insert | CDC trie | 119 | 8 | 203.8 |
| records | insert | mixed + runs + uniform | 96 | 6 | 225.2 |
| random | multi | ordinary trie | 477 | 2 | 8203.9 |
| random | multi | tight fixed trie | 439 | 34 | 393.4 |
| random | multi | CDC trie | 478 | 26 | 2349.0 |
| random | multi | mixed + runs + uniform | 491 | 22 | 2359.0 |
| zeros | multi | ordinary trie | 502 | 2 | 8203.9 |
| zeros | multi | tight fixed trie | 250 | 14 | 174.6 |
| zeros | multi | CDC trie | 277 | 12 | 1296.6 |
| zeros | multi | mixed + runs + uniform | 81 | 2 | 264.2 |

Patch retrieval reuses fetched bytes and needs no additional GETs in those link
cases. Eight sequential splices publish eight immutable intermediate roots; update
bytes include those roots. Tight trie export currently falls back to full export,
and the CDC trie control performs full rechunk/build. Their update CPU is not an
inherent trie cost. Treelist updates reuse opaque suffixes; a run boundary must use
successor-byte lookahead to stop rechunking promptly. Roots are still assembled from
a scan of routing descriptors, rather than a fully logarithmic editor.

Conclusion: content-defined chunking explains much of the improvement for
unaligned shifts, and the CDC trie is competitive with treelist routing. The current
block design selects trie routing with a content-defined prefix and page-defined
suffix. Tight fixed tries remain strong for page-aligned overwrites. These candidate
measurements do not benchmark the combined block format or establish production
performance, global edit-script minimality or move/copy instructions.

Explore the *comparison*[~][comparison] and *raw matrix*[~][file-comparison]. Earlier
*file-diff*[~][initial-diff] and *page-index*[~][page-index] controls retain their
original measurements separately.
