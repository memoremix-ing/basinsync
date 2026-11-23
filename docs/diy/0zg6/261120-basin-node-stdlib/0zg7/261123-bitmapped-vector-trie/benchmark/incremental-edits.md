[editor-browser-sizes]: <editor-browser-sizes.json>
[incremental-comparison]: <incremental-comparison.html>
[incremental-runs]: <incremental-runs.json>
[incremental-summary]: <incremental-summary.csv>
[lexidecimal]: <../../../../../../glossary/lexidecimal.md>
[strong-edge]: <../../../../../../glossary/strong-edge.md>
[vector-ablation]: <vector-ablation.json>
[vector-api-runs]: <vector-api-runs.json>
[vector-verification]: <vector-verification.json>

# Incremental edits and vector costs

Earlier comparisons measured bulk construction and reads; stored updates rebuilt
canonically. TypeScript now has explicit logical editors: materialize once,
path-copy edits, then export. Unchanged branches are shared, old snapshots survive,
and no storage, hashing or aggregation occurs during edits. Export still performs
a full canonical pass; selective loading/export and Rust/Go editors are not implemented.
Consumer summaries are recomputed on export without assuming associative callbacks.

Apple M2 / Bun 1.4.5, 100,000 integer values at consecutive indices starting at
zero or `2^200`. Map keys are UTF-8 *Lexidecimal*[~][lexidecimal]; translation is
outside timing, as before. These are client CPU measurements with local memory
storage, not S3 or browser CPU measurements. *Interactive comparison*[~][incremental-comparison].

## What the vector was missing

Cache parsed headers/bitmaps and child descriptors; use ready synchronous reads
and defer missing loads; extract numeric/base-32 index digits without per-level
bigint remainders. Partition sorted rows once rather than filtering 32 times,
and avoid awaiting synchronous consumer callbacks. Growing a logical vector
need not walk its contents for pruning.

Three fresh-process trials per isolated stage; alternating stage order.
Each stage adds to the preceding one; effects are conditional, not additive.
*Raw ablations*[~][vector-ablation]:

| Added change | Zero build ms | Zero get µs | 2^200 build ms | 2^200 get µs |
| --- | ---: | ---: | ---: | ---: |
| Prior implementation | 232.1 | 27.745 | 1127.2 | 173.574 |
| Parsed plans/descriptors | 222.1 | 2.099 | 1171.7 | 5.716 |
| Synchronous path, no remainder | 224.1 | 1.588 | 1222.8 | 3.261 |
| Number/base-32 digits | 223.7 | 1.483 | 1196.3 | 2.444 |
| Single-pass partitioning | 112.1 | 1.483 | 338.3 | 2.415 |
| Synchronous callbacks | 112.7 | 1.521 | 308.7 | 2.303 |

Repeated decoding dominates the original read deficit. Callback scheduling has
smaller, mixed effects; partitioning dominates the build improvement. The large-offset
vector still retains about 41 logical levels; the byte trie compresses that prefix.

A separate five-trial comparison of the final public APIs gives
*these results*[~][vector-api-runs] (32,768 cached reads after 8,192 warm reads):

| Start | Structure | Build ms | Get µs |
| --- | --- | ---: | ---: |
| 0 | trie | 143.4 | 2.289 |
| 0 | vector | 97.1 | 1.381 |
| 2^200 | trie | 146.1 | 2.552 |
| 2^200 | vector | 268.7 | 2.128 |

## Path-copied logical editing

Five fresh processes per structure/start. Bulk-build our editors; collection
builds by repeated `set`. Hot reads use 64 keys. After separate edit/append warmups,
perform 4,096 overwrites and 4,096 incrementing appends. Snapshot edits fence every
write in collection and retain every 32nd version; our editors are always immutable.
Batch edits fence collection only once, allowing its transient in-place writes.

| Start | Structure | Logical build ms | Get µs | Batch edit µs | Snapshot edit µs | Append µs |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | collection | 73.8 | 0.237 | 0.951 | 8.328 | 7.048 |
| 0 | trie | 16.6 | 0.256 | 1.332 | 1.536 | 1.024 |
| 0 | vector | 18.9 | 0.190 | 0.446 | 0.602 | 0.629 |
| 2^200 | collection | 77.3 | 0.278 | 1.086 | 8.542 | 6.937 |
| 2^200 | trie | 17.1 | 0.289 | 1.241 | 2.018 | 1.337 |
| 2^200 | vector | 31.5 | 1.231 | 2.641 | 2.846 | 3.509 |

Collection retains the two earlier repairs and has no comparable stored codec.
Its transient batch mode is competitive; snapshot fencing changes the comparison.
Logical editors operate on their own compressed/bitmapped object trees, not decoded
*basin edges*[~][strong-edge] or the public serialized-reader path. Values remain
borrowed and immutable; keys/structure are owned. *Raw runs*[~][incremental-runs]
and *summary*[~][incremental-summary] include phase counts and source fingerprints.

Full logical rebuild controls (eight edits, measured separately) and one canonical
export after the snapshot batch cost:

| Start | Structure | Rebuild ms/edit | Export ms |
| --- | --- | ---: | ---: |
| 0 | trie | 8.5 | 155.6 |
| 0 | vector | 11.5 | 105.1 |
| 2^200 | trie | 15.0 | 160.2 |
| 2^200 | vector | 26.2 | 388.5 |

The microsecond edit costs exclude these export costs. Existing stored `update`,
`push` and `pop` convenience methods still rebuild; use an editor to batch work.
Queries use a u32 LCG seeded with 42 (`x = 1664525*x + 1013904223`, modulo `2^32`),
then modulo entry count; key/index preparation is excluded.

## Verification and browser cost

*Old/new verification*[~][vector-verification] covers 48 graphs, byte-identical
objects and 332 cross-reader hit/miss checks. All 36 ablation trials also agree
on root digests, footprints and fetch counts. Tests cover shared subtrees, snapshot
immutability, randomized edits, sparse resizing, safe-number/radix boundaries,
non-associative async summaries, long prefixes, caller key mutation and load failures.
234 TypeScript/Rust/Go writer-reader cases and real storage/restart integration pass.

Full browser-target ESM exports, including logical editors, `Basin` and `MemoryStorage`:

| Structure | JS lines | JS bytes | Minified bytes | gzip bytes |
| --- | ---: | ---: | ---: | ---: |
| collection | 1,739 | 53,378 | 23,659 | 7,838 |
| trie | 2,213 | 74,381 | 41,876 | 13,287 |
| vector | 2,090 | 69,477 | 39,010 | 12,411 |

Trie + vector share dependencies: 50,661 minified bytes / 15,935 gzip bytes. gzip level 9;
no source maps, workload code or input encoders. Collection has no corresponding
persistence/integrity layer. *Complete sizes*[~][editor-browser-sizes] also record
source lines/bytes and Brotli quality 11.

```sh
bun scripts/benchmark-vector-pass.ts
bun scripts/verify-vector-pass.ts
TRIE_COST_COLLECTION_ADAPTER=/path/to/adapter bun scripts/benchmark-structure-edits.ts
STRUCTURE_TIERS=serialized bun scripts/benchmark-structure-comparison.ts
bun scripts/measure-structure-bundles.ts
```

The vector runner reconstructs controls from its pinned `VECTOR_PASS_BASE_REF` on
first use and reuses frozen sources thereafter. `VECTOR_PASS_ROOT`, `VECTOR_PASS_N`,
`VECTOR_PASS_ROUNDS`, `STRUCTURE_EDIT_OUT`, `STRUCTURE_EDIT_N` and
`STRUCTURE_EDIT_ROUNDS` select runs.
