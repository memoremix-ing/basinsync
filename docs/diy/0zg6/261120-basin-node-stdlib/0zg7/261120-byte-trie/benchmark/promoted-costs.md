[lexidecimal]: <../../../../../../glossary/lexidecimal.md>
[logical-costs]: <logical-costs.md>
[promoted-comparison]: <promoted-comparison.html>
[promoted-reads]: <promoted-reads.json>
[promoted-runs]: <promoted-runs.json>
[promoted-summary]: <promoted-summary.csv>
[promoted-verification]: <promoted-verification.json>

# Promoted TypeScript optimizations

Use stable nibble buckets built in one pass and sorted endpoints for common prefixes
and key bounds. Lookups carry an offset through compressed prefixes, inline children,
and deferred loads. Input keys remain owned; serialization, aggregation and integrity
checks retain their behavior. These promote the *measured prototypes*[~][logical-costs].

40 general trials plus 20 longer read trials; five per fixture/tier/version,
alternating version order.
Apple M2, Bun 1.4.5; same 100k integer-valued random and increasing *Lexidecimal*[~][lexidecimal] inputs.
All storage is local memory. *Interactive results*[~][promoted-comparison],
*summaries*[~][promoted-summary], *general runs*[~][promoted-runs] and *extended reads*[~][promoted-reads], with source fingerprints.

| Keys | Metric | Before | After |
| --- | --- | ---: | ---: |
| Random | Logical build ms | 97.3 | 67.8 |
| Random | Serialized API build ms | 154.9 | 126.5 |
| Random | Cached API get µs (65,536 reads) | 1.915 | 1.697 |
| Lexidecimal | Logical build ms | 128.7 | 69.0 |
| Lexidecimal | Serialized API build ms | 206.1 | 141.7 |
| Lexidecimal | Cached API get µs (65,536 reads) | 2.582 | 2.312 |

The logical tier times construction alone using the existing in-memory control;
its reader is unchanged and unreported. The serialized API tier includes framing,
hashing, storage and verified reads. This distinction avoids presenting the earlier
logical-reader prototype timings as public API timings. The short 4096-read phase
had overlapping ranges; longer 65,536-read loops reduced warm-up noise. The optimized
reader won every paired longer-loop trial, with roughly 10–11% lower medians.

Serialized root digests, stored bytes/counts, heights and fetch counts agree across
all measured before/after cases. *Verification*[~][promoted-verification] additionally
covers 12 fixtures / 24 serialized graphs, 8,948 public hit/miss reads and 4,442
logical-reader probes, including value-edge packing and async aggregation. Tests
exercise offsets across uncached compressed-prefix boundaries and caller key mutation.

131 client tests, 234 cross-language cases, browser build and live reservation/upload/
publication/promotion/restart integration pass. The format and public APIs are unchanged.
Updates still rebuild canonically; incremental path-copying remains the next write-side step.

```sh
bun scripts/benchmark-trie-release.ts
TRIE_RELEASE_TIERS=serialized-api TRIE_RELEASE_HOT=65536 \
  bun scripts/benchmark-trie-release.ts
TRIE_VERIFY_VARIANTS=baseline,optimized \
  bun scripts/verify-trie-logic.ts /path/to/release-snapshots
```

`TRIE_RELEASE_BASE_REF`, `TRIE_RELEASE_FIXTURES`, `TRIE_RELEASE_N`,
`TRIE_RELEASE_LAYOUTS`, `TRIE_RELEASE_ROUNDS`, `TRIE_RELEASE_TIERS`,
`TRIE_RELEASE_HOT` and `TRIE_RELEASE_OUT` select runs.
Historical ablation tools pin their pre-promotion source via `TRIE_LOGIC_BASE_REF`
or `TRIE_COST_DONOR_REF`, preserving the meaning of their individual variants.
