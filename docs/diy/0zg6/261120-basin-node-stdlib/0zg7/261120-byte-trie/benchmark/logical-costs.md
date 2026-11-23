[collection-performance]: <collection-performance.md>
[lexidecimal]: <../../../../../../glossary/lexidecimal.md>
[logical-capabilities]: <logical-capabilities.json>
[logical-comparison]: <logical-comparison.html>
[logical-construction]: <logical-construction.json>
[logical-readers]: <logical-readers.json>
[logical-summary]: <logical-summary.csv>
[promoted-costs]: <promoted-costs.md>

# Bisect logical capabilities and implementation costs

2026-11-23; Apple M2 / Bun 1.4.5. Logical-only prototypes at the 255-entry cap,
without base reversed-key bounds. 100k integer values, count aggregation, no network
or serialization in timed phases. Five fresh-process runs per case; rotate variants.
262,144 checked reads use the same 64-key hot set.

220 trials: raw *construction runs*[~][logical-construction], *reader runs*[~][logical-readers],
and *capability splits*[~][logical-capabilities]. *Summaries*[~][logical-summary] and
*interactive comparison*[~][logical-comparison].

## Coarse capability split

Use a 2×2 control before subdividing the costly half. On ascending UTF-8
*Lexidecimal*[~][lexidecimal] keys:

| Builder | Full headers + aggregation ms | Bounds/aggregation disabled ms |
| --- | ---: | ---: |
| Original | 129.6 | 109.6 |
| Single-pass buckets + endpoints | 69.1 | 60.3 |

The contemporaneous adapted *collection*[~][collection-performance] builds in 66.8 ms.
Removing richer metadata saves about 20 ms with the old builder, or 9 ms with the
optimized builder. Most of the original gap is repeated implementation work,
not the required features. Effects interact: performance is not monotonic like
a correctness bisection.

The finer controls separately disable header bounds/nullity scans and consumer
entry/combine work. Prefixes, counts and packing fields remain. These disabled
controls are diagnostic trees, not supported publication formats.

## Which implementation work?

Construction, retaining all metadata:

| Only change | Lex build ms |
| --- | ---: |
| Original | 127.3 |
| Prefix and key bounds from sorted endpoints | 114.5 |
| One-pass high/low nibble buckets | 77.3 |
| Both | 71.2 |

Sorted endpoints determine the common prefix and inclusive key bounds. Partition
once rather than filtering each bucket 16 times. These changes preserve the exact
serialized graph; 44 graph comparisons cover empty/prefix keys, 255/256 and
1280/1281 boundaries, random/ordered keys and asynchronous aggregates.

## Reader split

| Reader | Lex get µs |
| --- | ---: |
| Original | 0.385 |
| Hoist group-search closure | 0.389 |
| Prefix loop without callback | 0.344 |
| Offsets instead of suffix views | 0.304 |
| Combined offset loop | 0.221 |
| Adapted collection | 0.275 |

The offset-only comparator preserves callbacks and lower-bound search; it changes
suffix representation and the required comparison interface. The combined loop
also uses a manual prefix scan, shared finder, and fixed comparison length. Hoisting
the finder alone has no clear benefit. 4,442 separate hit/miss/prefix checks pass.

Deferring physical cuts gives direct logical child references; combined with the
offset reader this reaches 0.191 µs in a separate suite. It changes the editing
representation, so needs a later serialization/packing stage. These prototypes
retain live objects; this is not a serialized-reader or zero-copy parsing result.

## Next steps

Carry forward the byte-preserving build changes and the offset logical reader
before removing useful metadata. Then implement the already-planned incremental
path-copying. An ascending-append path could retain the rightmost traversal path,
validate ordering and touch only affected ancestors; that idea is not timed here.

```sh
TRIE_LOGIC_SUITE=construction bun scripts/benchmark-trie-logic.ts
TRIE_LOGIC_SUITE=readers bun scripts/benchmark-trie-logic.ts
TRIE_LOGIC_SUITE=capabilities bun scripts/benchmark-trie-logic.ts
bun scripts/verify-trie-logic.ts /path/to/construction-snapshots
```

Supply `TRIE_COST_COLLECTION_ADAPTER` to include the historical collection.
`TRIE_LOGIC_OUT`, `TRIE_LOGIC_FIXTURES`, `TRIE_LOGIC_N`, `TRIE_LOGIC_LAYOUTS`,
`TRIE_LOGIC_ROUNDS` and `TRIE_LOGIC_VARIANTS` select runs. Fixtures follow the preceding
benchmark’s layout. The recorded source snapshots match the checked-in harness’s
outputs; all production algorithms remain unchanged by this exploration.

The byte-preserving builder and offset reader are now implemented; see the
*promotion measurements*[~][promoted-costs].
