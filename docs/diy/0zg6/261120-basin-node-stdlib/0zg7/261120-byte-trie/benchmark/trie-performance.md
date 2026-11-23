[baseline]: <baseline.json>
[comparison]: <comparison.html>
[flexbuffers]: <../../../../../../glossary/flexbuffers.md>
[json0]: <../../../../../../glossary/json0.md>
[legacy-probe]: <legacy-probe.json>
[lexidecimal-keys]: <lexidecimal-keys.md>
[node]: <../../../../../../glossary/node.md>
[optimized]: <optimized.json>
[sha384]: <../../../../../../glossary/sha384.md>
[summary]: <summary.csv>
[trie]: <../../../../../../glossary/trie.md>

# Trie measurements

2026-11-23; Apple M2, 24 GiB, macOS arm64. Bun 1.4.5; Rust 1.92.0
(`--release`); Go 1.27.1 (normal optimized build). Median of three fresh-process
runs, rotating language order. *Interactive results*[~][comparison],
*all summaries*[~][summary], and raw *baseline*[~][baseline] / *optimized*[~][optimized] samples.

## 100,000 random 16-byte keys

| Implementation | Build ms | Cached lookup µs | Full scan ms | Replace one ms | Replace 100 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 205.3 | 38.4 | 73.9 | 394.1 | 399.4 |
| Rust | 95.3 | 17.2 | 60.3 | 143.6 | 143.7 |
| Go | 78.7 | 31.2 | 20.9 | 108.8 | 112.5 |

Cached lookup, before → after: TypeScript 90.9 → 38.4 µs (2.37×),
Rust 24.5 → 17.2 µs (1.43×), Go 47.2 → 31.2 µs (1.51×). Across all
100k-entry key layouts, gains are 1.9–2.4× / 1.2–1.4× / 1.3–1.5× respectively.
These compare our own pre-/post-optimization implementations; `dictionary.ts` has no score.

## What was measured

Shared, deterministically shuffled fixtures: 1k/10k/100k entries, integer values,
16-byte random keys, UTF-8 project paths, and 32-byte shared prefixes plus four-byte
counters. Every implementation uses the count aggregate, normal framing, hashes,
validation and its in-memory storage adapter; JSON input parsing is outside phase
timings. Each worker warms code on 256 rows first.

Build includes serialization and storage. A 64-key hot set is primed before 4096
checked lookups; 1024 spread hits and appended-`ff` misses follow. Then 128 lookups
clear the reader cache individually, followed by full/prefix scans, 1000 aggregate
prunes, and separate one-/100-value update batches. Scan timings include consuming
every value; prefix scans run after the full scan. Updates start from the same root.

No network latency is injected. Cold random-key reads fetch two *basin nodes*[~][node]
per lookup at 100k entries; hot reads and aggregate prunes fetch none. Before/after
object counts, serialized lengths, heights, prefix counts and fetch counts agree
in all 27 dataset/language comparisons. Encodings differ between languages:
the random 100k graphs occupy 2.47 / 2.51 / 2.68 MiB.

Peak process RSS is about 548 / 121 / 132 MiB in that case. This includes fixture
parsing, warm-up, retained snapshots and both updates; it is not retained-index
memory. TypeScript allocation/heap profiling remains worthwhile.

## Changes and next target

Compare metadata against borrowed buffer values instead of re-encoding it
(*FlexBuffers*[~][flexbuffers] in TypeScript, *JSON0*[~][json0] in Go) or allocating owned copies (Rust).
Keep descriptor comparisons on cache hits and all digest/type/bounds checks.
Also remove per-byte hex formatting allocations, bound a private TypeScript
map-key UTF-8 cache, and compare Go map keys without temporary strings. Nested
mutation tests, format round trips and cross-language readers guard these changes.

Go leads build/scan throughput here; Rust leads cached lookup. Single-key updates
still rebuild the *trie*[~][trie] and are nearly as expensive as 100 changes together.
Prefer batched updates now; incremental canonical path updates are the next
write-side optimization. Reader header/edge allocation is a further CPU target.

## Historical dictionary

The requested `ptr-io/foglog/stream-load/dictionary.ts` cannot provide a full-trie
comparison as checked: importing it calls an unimplemented `SAUTable.openWindow`.
Removing only that demo and exposing its existing `dSet` reaches
`ReferenceError: cWrite is not defined` on the first insertion. `cGroup`, `cBranch`,
`cLeaf` and `cHandle` are also referenced without implementations/imports.
The read-only *probe record*[~][legacy-probe] includes its *SHA-384*[~][sha384]. No substitute
algorithm was scored as the historical dictionary.

## Repeat

```sh
cargo build --release -p basinsync-structures --example benchmark
(cd go/structures && go build -o ../../.local/trie-benchmark-go ./cmd/benchmark)
bun run bench:trie
bun scripts/probe-legacy-dictionary.ts /path/to/dictionary.ts
```

`TRIE_BENCH_SIZES`, `TRIE_BENCH_LAYOUTS`, `TRIE_BENCH_IMPLS`,
`TRIE_BENCH_ROUNDS`, `TRIE_BENCH_LABEL` and `TRIE_BENCH_OUT` select runs.
Raw reports include per-phase timings, fetch counts/bytes, whole-process peak
RSS, machine/toolchain details, and production-source *SHA-384*[~][sha384] fingerprints.

Follow-up: *increasing Lexidecimal keys and sequential reads*[~][lexidecimal-keys].
