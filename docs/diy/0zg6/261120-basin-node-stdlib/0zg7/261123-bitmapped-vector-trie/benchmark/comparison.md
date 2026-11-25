[browser-sizes]: <browser-sizes.json>
[comparison]: <comparison.html>
[comparison-runs]: <comparison-runs.json>
[comparison-summary]: <comparison-summary.csv>
[diy/0zg6/261120-basin-node-stdlib]: <../../../README.md>
[envbuf]: <../../../../../../glossary/envbuf.md>
[flexbuffers]: <../../../../../../glossary/flexbuffers.md>
[incremental-edits]: <incremental-edits.md>
[lexidecimal]: <../../../../../../glossary/lexidecimal.md>
[node]: <../../../../../../glossary/node.md>
[strong-edge]: <../../../../../../glossary/strong-edge.md>

# Incrementing positions: vector, byte trie and collection

These measurements precede the *logical editors and vector optimizations*[~][incremental-edits].

Apple M2 / Bun 1.4.5; five fresh-process trials per structure, tier and start,
with alternating execution order. Medians below; *runs*[~][comparison-runs],
*summary*[~][comparison-summary], *browser sizes*[~][browser-sizes] and
*comparison tables*[~][comparison] retain details.

100,000 integer values at consecutive positions. Vector takes bigint indices;
the maps take UTF-8 *Lexidecimal*[~][lexidecimal] keys. Preparation is outside
measurement. The `2^200` vector has holes before its first entry, with logical
length `2^200 + 100000`; this is a sparse workload, not a dense array shifted in memory.

## Logical control

Actual builders with benchmark-only synthetic *basin edges*[~][strong-edge] and
raw-object readers: no serialization, integrity crypto or storage. Our structures
compute a count aggregate; collection has no equivalent aggregation callback.
262,144 synchronous hot reads over 64 preselected keys, after 8,192 warm reads.
All 100,000 entries are checked after timing in every logical trial.

| Start | Structure | Build ms | Hot get µs |
| --- | --- | ---: | ---: |
| 0 | collection | 69.1 | 0.255 |
| 0 | trie | 74.3 | 0.222 |
| 0 | vector | 147.7 | 0.291 |
| 2^200 | collection | 70.2 | 0.284 |
| 2^200 | trie | 78.6 | 0.280 |
| 2^200 | vector | 910.3 | 1.785 |

The adapted historical `collection.ts` retains the two repairs from the earlier
comparison: preserve live pointer references, and allow disabled absolute prefixes.
Its point operations are checked here; its broken ordered `at()` traversal is excluded.
This tier's raw readers are controls, not our public APIs.

## Serialized public APIs

Real *basin nodes*[~][node], *EnvBufs*[~][envbuf], *FlexBuffers*[~][flexbuffers],
SHA-384/HMAC capabilities, verified local-memory storage and awaited public `get`.
32,768 hot reads after 8,192 warm reads. Collection lacks comparable persisted
framing/verification and is deliberately absent from this tier. No S3 requests occur.

| Start | Structure | Build ms | Hot get µs | Stored bytes | Objects |
| --- | --- | ---: | ---: | ---: | ---: |
| 0 | trie | 143.6 | 2.313 | 1,209,416 | 396 |
| 0 | vector | 188.9 | 23.490 | 849,976 | 99 |
| 2^200 | trie | 145.6 | 2.603 | 1,209,920 | 394 |
| 2^200 | vector | 965.6 | 150.885 | 854,768 | 99 |

Vector saves about 30% of stored bytes and uses 99 objects versus roughly 395.
128 independent cold lookups require 256 storage reads for vector versus 383–384
for trie; this does not predict network wall time. Public vector hot reads are
about 10× slower at zero and 58× slower at the large offset.

The current vector repeatedly filters 32 buckets per logical level, awaits
synchronous aggregation callbacks, and parses/validates lookup parts on every
traversal. Its large-offset path retains about 41 five-bit levels, unlike the
compressed byte trie. These are profiling targets, not measured individual
causal contributions or inherent bitmap-vector limits. No vector optimization
is folded into this comparison. Builds are bulk construction; repeated append,
incremental updates and full scans are not measured.

## Browser code size

Browser-target ESM bundles retain complete exported class APIs; no source maps.
Our full entries export `Basin`, `MemoryStorage` and the structure; collection
exports `EagerCollection`, `CConfig` and snapshot `expire`. No server/AWS client
code is included. Input encoders, workload harnesses and consumer callbacks are
excluded for all entries. These are Bun browser builds, not browser CPU timings.
Lines include blank lines/comments; minified line counts are not meaningful.
Source counts exclude shared infrastructure; vector includes its packing helper,
collection includes its four local modules.

| Structure | Source lines / bytes | Bundled JS lines / bytes | Minified bytes | gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| collection | 2,966 / 88,554 | 1,739 / 53,378 | 23,659 | 7,838 | 6,932 |
| trie | 592 / 19,222 | 1,997 / 68,158 | 38,184 | 12,095 | 10,987 |
| vector | 322 / 9,435 | 1,777 / 60,548 | 34,128 | 10,812 | 9,814 |

gzip level 9; Brotli quality 11. Bundle bytes include transitive runtime code.
Trie and vector together are 42,373 minified bytes (13,517 gzip / 12,242 Brotli),
so adding vector to trie costs 4,189 minified bytes, and adding trie to vector
costs 8,245. Compression differences are whole-bundle differences, not independently
cacheable module sizes. Core-only is 29,668 minified bytes; class-only exports,
which still pull required parsing helpers, are 32,876 for trie and 28,708 for vector.
Full APIs differ in features: collection does not include our persisted codec or
integrity/capability machinery. Actual applications may tree-shake further.

Apply the shared *implementation considerations*[~][diy/0zg6/261120-basin-node-stdlib]
to vector and B-tree profiling before changing their formats.

```sh
# Reuse the copied/repaired historical adapter from the collection comparison.
TRIE_COST_COLLECTION_ADAPTER=/path/to/adapter \
  bun scripts/benchmark-structure-comparison.ts
TRIE_COST_COLLECTION_ADAPTER=/path/to/adapter \
  bun scripts/measure-structure-bundles.ts
```

`STRUCTURE_N`, `STRUCTURE_ROUNDS`, `STRUCTURE_CASES`, `STRUCTURE_TIERS`,
`STRUCTURE_OUT` and `STRUCTURE_BUNDLE_OUT` select runs. Timed source fingerprints
are included in the raw results; comparison code does not bypass production checks.
