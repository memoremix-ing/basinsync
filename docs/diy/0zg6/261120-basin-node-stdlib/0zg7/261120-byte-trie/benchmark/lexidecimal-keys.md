[collection-performance]: <collection-performance.md>
[legacy-probe]: <legacy-probe.json>
[lexidecimal]: <../../../../../../glossary/lexidecimal.md>
[lexidecimal-comparison]: <lexidecimal-comparison.html>
[lexidecimal-summary]: <lexidecimal-summary.csv>
[lexidecimal-wide]: <lexidecimal-wide.json>
[lexidecimal-zero]: <lexidecimal-zero.json>
[trie-performance]: <trie-performance.md>

# Increasing Lexidecimal keys

There is no measured speed comparison with `dictionary.ts`: its import calls missing
`openWindow`; removing only that demo exposes missing `cWrite` on the first insert.
The *probe*[~][legacy-probe] records both failures. The earlier 2.37× result compared
our TypeScript implementation before and after optimization.

Use UTF-8 bytes of `lex(start + i)`, matching SyncBlock page keys. Measure both
ascending and shuffled input, selecting identical logical lookup keys for each.
Fixtures have 1k/10k/100k integer values and a count aggregate. This isolates key
shape; page blobs and their checksums are not timed.

135 fresh-process trials on the same Apple M2, with three trials per combination.
*Interactive comparison*[~][lexidecimal-comparison], *summaries*[~][lexidecimal-summary],
and raw runs starting at *zero*[~][lexidecimal-zero] and *2^200*[~][lexidecimal-wide].

## 100k keys starting at zero, ascending input

| Implementation | Build ms | Cached get µs | Sequential get µs | Scan ms |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 389.8 | 73.0 | 59.3 | 142.0 |
| Rust | 205.7 | 36.8 | 28.6 | 101.4 |
| Go | 134.1 | 57.3 | 48.0 | 51.3 |

For TypeScript, the fresh random-key control built in 213.0 ms and used 39.6 µs
per cached lookup. *Lexidecimal*[~][lexidecimal] uses more CPU here, while improving
sequential locality: the first 1024 keys need 7 object fetches versus 560. Those
are memory-backend fetch counts; no network delay is injected.

At 100k, the TypeScript graph uses 396 objects / 1.90 MiB, versus 257 / 2.47 MiB
for random keys. Its physical height rises from one to two, so most uncached
lookups need three fetches. Starts near `2^200` gave 390.6 ms build and 73.6 µs
cached lookup in TypeScript.

Ascending/shuffled input produced identical root digests, serialized lengths,
object counts and heights for every language/size/offset. Input order changes
construction cost, not the canonical graph. These are bulk builds, not incremental
insertion measurements; single-value updates still rebuild.

The version-2 harness adds a cache-cleared sweep of up to 1024 consecutive keys
after individual cold lookups. Other phases follow the *original methodology*[~][trie-performance].
The `miss` phase still appends `ff`, testing interior missing byte keys.

```sh
TRIE_BENCH_LAYOUTS=lexidecimal,lexidecimal-shuffled bun run bench:trie
```

Set `TRIE_BENCH_LEX_START` to a nonnegative decimal or hexadecimal bigint for
other starting positions. Raw reports record that offset and source fingerprints.

Follow-up: *adapted historical collection comparison*[~][collection-performance].
