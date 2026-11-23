[client-cost-ablation]: <client-cost-ablation.json>
[client-cost-api]: <client-cost-api.json>
[client-cost-crypto]: <client-cost-crypto.json>
[client-cost-summary]: <client-cost-summary.csv>
[client-costs-comparison]: <client-costs-comparison.html>
[collection-performance]: <collection-performance.md>
[flexbuffers]: <../../../../../../glossary/flexbuffers.md>
[group-cap-255]: <group-cap-255.json>
[lexidecimal]: <../../../../../../glossary/lexidecimal.md>
[lexidecimal-grouping]: <lexidecimal-grouping.json>
[logical-costs]: <logical-costs.md>
[node]: <../../../../../../glossary/node.md>
[sha384]: <../../../../../../glossary/sha384.md>
[trie]: <../../../../../../glossary/trie.md>

# TypeScript client costs

2026-11-23; Apple M2, 24 GiB; Bun 1.4.5 / JavaScriptCore. No server or network
operations: all storage is local memory. Use the same 100k integer-valued
random/ascending UTF-8 *Lexidecimal*[~][lexidecimal] fixtures and count aggregate as the
*collection comparison*[~][collection-performance]. These are runtime-specific CPU measurements.

*Interactive comparison*[~][client-costs-comparison] and *summaries*[~][client-cost-summary].
Raw runs: *102 ablations*[~][client-cost-ablation], *40 final/API trials*[~][client-cost-api],
*12 crypto-instrumented trials*[~][client-cost-crypto]. Medians of three/five/three
fresh-process runs respectively, rotating variants and counterbalancing API loop order.

## Logical client comparison

Bypass framing, serialization, cryptographic identities and storage in an isolated
prototype using the same canonical builder and ordinary-object traversal. Synthetic
local edge identities are never published; this is not a production hash-disable option.
Both readers use 262,144 checked lookups over the same 64-key hot set.

| Keys | Implementation | Build ms | Logical get µs |
| --- | --- | ---: | ---: |
| Random | Our logical prototype | 106.6 | 0.196 |
| Random | Adapted collection | 114.3 | 0.236 |
| Lexidecimal | Our logical prototype | 154.7 | 0.437 |
| Lexidecimal | Adapted collection | 65.7 | 0.279 |

Point traversal is comparable; the collection still builds sequential keys faster.
This removes the earlier comparison’s storage-format responsibilities. The collection
retains its two documented repairs; broken ordered traversal remains unscored.

## One change at a time

Each row below starts from the original serialized implementation. Do not add gains:
the changes interact. Builds still serialize and hash *Basin nodes*[~][node].

| Only change | Random build ms | Random get µs | Lex build ms | Lex get µs |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 206.3 | 39.42 | 376.6 | 73.06 |
| Prototype methods on References | 202.5 | 34.25 | 381.5 | 61.90 |
| Await only asynchronous aggregates | 210.9 | 39.20 | 380.8 | 72.80 |
| Owned descriptor snapshots; ready cache | 210.9 | 30.85 | 381.4 | 61.09 |
| Retain parsed lookup plans | 203.9 | 13.64 | 373.7 | 20.14 |
| Index MemoryStorage allocations | 171.7 | 38.69 | 313.8 | 71.99 |
| Native hex, portable fallback | 176.1 | 37.23 | 320.6 | 70.66 |
| Bun-native SHA/HMAC experiment | 193.5 | 38.20 | 356.6 | 72.96 |

The allocation index removes a test-store scan; it is not a trie algorithm gain.
The native-crypto experiment changes the crypto API, retaining identical SHA/HMAC
outputs; production keeps browser-compatible Web Crypto. Synchronous aggregate
callbacks alone contribute little here.

## Combined reader and scheduling

Retain decoded lookup headers, key groups and selected edges; validate supplied
descriptors against private owned metadata snapshots. Keep normal digest checks on
fetch. Use prototype methods, indexed memory allocations and native hex with a fallback.

| Keys | Previous get µs | Updated get µs | Updated build ms |
| --- | ---: | ---: | ---: |
| Random | 38.73 | 2.57 | 178.3 |
| Lexidecimal | 73.32 | 3.65 | 296.0 |

Above uses the same 4096-lookup phase. Longer 65,536-read loops isolate the updated
public APIs with identical plans and descriptor checks:

| Keys | Direct `getOrDefer` µs | Await `get` µs |
| --- | ---: | ---: |
| Random | 1.787 | 1.806 |
| Lexidecimal | 2.709 | 2.724 |

Paired median differences are only 6–7 ns; ranges cross zero (−36…70 ns random,
−26…84 ns Lexidecimal). These runs establish no meaningful scheduling advantage. It defers I/O until resumed; `get`/`getView` retain
their Promise APIs. The logical prototype separately measures an async wrapper
around its identical direct traversal. More sampling improves JIT warm-up in these
longer loops; compare API rows to each other, not to the shorter-loop table.

## Hashing

Each sealed node computes *SHA-384*[~][sha384] of framed bytes and one HMAC-SHA384
for entropy; Web Crypto imports the HMAC key. A cache miss verifies SHA-384 once.
Cached reads hash nothing. Consumer aggregation here counts entries: no key/value
Merkle hashing, directory digest, page checksum or token/HKDF derivation is timed.

The baseline’s instrumented build breakdown is:

| Keys | SHA ms | HMAC import/sign ms | Total crypto / build ms |
| --- | ---: | ---: | ---: |
| Random | 6.4 | 3.5 | 9.9 / 207.7 |
| Lexidecimal | 14.0 | 6.0 | 20.0 / 383.9 |

These call-wall-time sums include API scheduling and instrumentation, not isolated
hash compression cycles. Cold reads spend a larger fraction hashing fetched bytes;
raw counters include call counts and byte volumes. For a logical in-memory comparison,
these hashes are unnecessary. They remain relevant when measuring serialization
and verified loading, even without a server.

## Confidence and repeat

All real-node variants produce identical root digests. Checks cover every logical
and collection value, point reads, scans, retained update snapshots, metadata mutation,
lazy I/O, shared pending loads, failure/retry and generator catch/finally. All 127
client tests and 216 TypeScript/Rust/Go writer-reader cases pass; the browser bundle
builds. Cached plans retain additional metadata; serialized cache budgets are not
total JavaScript heap limits. Incremental path-copying remains the next write-side task.

```sh
TRIE_BENCH_SIZES=100000 TRIE_BENCH_LAYOUTS=random,lexidecimal \
  TRIE_BENCH_IMPLS=typescript TRIE_BENCH_ROUNDS=1 \
  TRIE_BENCH_OUT=.local/trie-lex-zero bun run bench:trie
TRIE_COST_BASE_REF=yuuxmlsq bun scripts/benchmark-trie-costs.ts
```

Set `TRIE_COST_COLLECTION_ADAPTER` to the isolated adapter directory from the
collection benchmark to include it. `TRIE_COST_VARIANTS`, `TRIE_COST_ROUNDS`,
`TRIE_COST_N`, `TRIE_COST_FIXTURES` and `TRIE_COST_OUT` select experiments.
`TRIE_COST_PROFILE=1` enables crypto counters; keep those separate from throughput
runs. Raw reports fingerprint each source variant and the worker.

## Why Lexidecimal favors the collection

*Follow-up measurements*[~][lexidecimal-grouping]: 90 logical-only trials, five per
configuration, plus separate structural counts. Hex characters have only 16 possible
values: two characters span 256 keys. The then-current 63-entry group cap splits that dense
subtree where the collection's approximately 256-entry leaves retain it.

On the same 100k ascending keys, raising only our experimental cap to 256 reduces
logical *trie nodes*[~][trie] from 6,669 to 420 and nonempty groups from 6,250 to 392—matching
the collection's counts and size histogram. Maximum logical depth falls from four
to three. These are *trie nodes*[~][trie], not stored-object counts.

Logical lookup falls from 0.436 to 0.365 µs, versus the collection's earlier
0.279 µs: roughly half the gap. Random-key topology and lookup are unchanged.
Returning immediately on binary-search equality alone gives only 0.424 µs.

Construction improves from 153.7 to 144.4 ms, still far from the collection's
65.7 ms. Separately, computing reversed-key bounds without reversing every key
reduces a fresh 153.8 ms baseline to 136.2 ms; combining that with larger groups
reaches 128.6 ms. Consolidation explains part of the advantage, not the whole build
cost. Metadata work and construction strategy remain distinct targets.

These preceding measurements used the earlier format. The group experiment driver
accepts the `logical-final` source snapshot emitted by the cost benchmark.

## Adopt 255; leave reversed bounds to consumers

The *255-cap follow-up*[~][group-cap-255] records 60 additional logical-only trials
and direct encoder-width probes. A zero-valued vector grows from 259 to 518 encoded
bytes at 255→256 entries (one-byte to two-byte elements). In a group containing
two-byte key blobs and six-digit integer values, offsets/values already require
two/four-byte elements at both lengths: the whole group grows only 2589→2601 bytes.

With base reversed bounds removed, 100k ascending keys give 420 logical nodes at
either cap; 255 uses 781 nonempty groups versus 392 at 256. Lookup is 0.384 versus
0.371 µs; construction is 126.9 versus 125.1 ms. The earlier 63 cap gives 0.431 µs
and 131.5 ms without reversed bounds.

The shared format now caps groups at 255 and omits `reversals` from headers in
TypeScript, Rust and Go. Consumers can aggregate reversed-key bounds through
footer summaries. Boundary tests cover 255/256 and reject an unsplit 256-entry
group; 129 client tests, native tests and 234 cross-language cases pass, as does
live reservation/upload/commit/promotion/restart integration.

Follow-up: *capability bisection and logical implementation costs*[~][logical-costs].
