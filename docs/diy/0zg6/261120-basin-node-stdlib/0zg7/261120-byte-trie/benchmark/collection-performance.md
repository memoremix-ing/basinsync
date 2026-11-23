[collection-comparison]: <collection-comparison.html>
[collection-runs]: <collection-runs.json>
[collection-summary]: <collection-summary.csv>
[flexbuffers]: <../../../../../../glossary/flexbuffers.md>
[lexidecimal]: <../../../../../../glossary/lexidecimal.md>
[lexidecimal-keys]: <lexidecimal-keys.md>
[node]: <../../../../../../glossary/node.md>
[sha384]: <../../../../../../glossary/sha384.md>
[trie-performance]: <trie-performance.md>

# Historical collection comparison

`collection.ts` runs after two isolated adaptations. The historical checkout is
unchanged; timings below are for the adapted `EagerCollection`, not its unmodified
source. *Interactive results*[~][collection-comparison], *summaries*[~][collection-summary],
and *126 alternating trials*[~][collection-runs] record the measurements and exact patches.

2026-11-23; Apple M2, 24 GiB; Bun 1.4.5. Median of three fresh-process runs per
implementation/fixture, alternating execution order. Reuse the *earlier fixtures*[~][lexidecimal-keys]:
1k/10k/100k integer values; random bytes, paths, shared prefixes, and ascending/shuffled
UTF-8 *Lexidecimal*[~][lexidecimal] keys starting at zero or `2^200`.

## 100k entries

| Keys | Implementation | Build ms | Cached get µs | Replace one ms | Replace 100 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Random | Current trie | 200.8 | 38.136 | 392.428 | 406.073 |
| Random | Adapted collection | 108.5 | 0.465 | 0.097 | 0.706 |
| Ascending Lexidecimal | Current trie | 378.2 | 72.384 | 561.839 | 582.928 |
| Ascending Lexidecimal | Adapted collection | 71.5 | 0.507 | 0.065 | 0.626 |
| Paths | Current trie | 432.3 | 61.187 | 782.327 | 794.424 |
| Paths | Adapted collection | 96.7 | 1.177 | 0.106 | 0.638 |

The collection is substantially faster on these point operations. This compares
public APIs with different responsibilities: its synchronous reads traverse live
JavaScript objects; our async reads traverse serialized, validated *Basin nodes*[~][node].
Our builds also aggregate, encode *FlexBuffers*[~][flexbuffers], frame, hash and store objects. The collection
uses its default configuration and built-in counts; no storage codec or network
is involved. These ratios are not isolated algorithm comparisons.

The useful write-side lesson is concrete: the collection incrementally copies
shared paths after license expiry; our updates rebuild the complete graph. The
single-value cost remains the clearest target for improvement.

## Adaptations and limits

Dereferencing called `asPointer(handle.pointer)` with no value, clearing both
the cached and mutable references. Preserve the pointer instead:

```ts
const ptr = handle.pointer;
```

Four traversal checks expected absolute prefixes even though both constructors
deliberately set `prefix = -1`. Treat that value as disabled:

```ts
if (node.prefix !== -1 && depth !== node.prefix) {
  throw new Error("Encountered incorrect prefix.");
}
```

No other legacy algorithms are changed. Ordered `at()` traversal still produces
wrong keys or throws `Unexpected gap`; scan throughput is therefore unscored.
No serialized size, cold object fetch, aggregate-pruning or network comparison
is claimed. Validation covers these fixtures, not general collection correctness.

## Checks and repeat

Each collection build checks its size; both workers check timed reads and misses.
After each independent collection one-/100-value update, verify every current
value and every value in the retained original snapshot. Snapshot tests expire the mutation license
before writing. Input parsing and final full validations are outside phase timings.
Both workers warm on 256 entries and use the same hot/spread/sequential keys.
Our worker retains its *existing phases*[~][trie-performance]; legacy sequential reads
have no cold-cache equivalent. Whole-process RSS includes fixtures and validation.

```sh
COLLECTION_BENCH_OUT=.local/collection-benchmark \
  bun scripts/benchmark-legacy-collection.ts /path/to/collection.ts
```

The runner copies four local source files into its ignored output folder, checks
patch occurrence counts, and fingerprints originals and timed sources with
*SHA-384*[~][sha384]. It requires the sibling `matter.ts`, `change-management/` and
`result-types/` files. `TRIE_BENCH_SIZES` and `COLLECTION_BENCH_ROUNDS` reduce or
expand runs; the defaults produce the recorded 126 trials.
