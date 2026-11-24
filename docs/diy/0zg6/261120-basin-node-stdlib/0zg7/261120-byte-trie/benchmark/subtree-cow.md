[cow-browser-smoke]: <cow-browser-smoke.json>
[cow-size]: <cow-size.json>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie]: <../README.md>
[node]: <../../../../../../glossary/node.md>
[strong-edge]: <../../../../../../glossary/strong-edge.md>
[subtree-cow]: <subtree-cow.html>
[subtree-cow-runs]: <subtree-cow-runs.json>
[subtree-cow-summary]: <subtree-cow-summary.csv>

# Subtree splicing and COW interfaces

Use the *prefix and draft APIs*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie].
Recommendation: keep relative handles and explicit path updates as core primitives;
keep Proxy drafts opt-in. Views help defer fetching/materialization, but export is
not yet selective. These TypeScript experiments do not establish Rust/Go or browser
CPU performance.

Apple M2 / Bun 1.4.5; five fresh-process trials per case, alternating implementation
order. *Interactive comparison*[~][subtree-cow], *raw runs*[~][subtree-cow-runs],
*summary*[~][subtree-cow-summary] and *code sizes*[~][cow-size]. Network latency is
absent; storage counters come from a traced `MemoryStorage` adapter.

## Prefix operations

100,000 integer-valued files across 100 folders, plus `/keep`. Copy one 1,000-entry
folder to 32 distinct prefixes. Per-key insertion receives an already selected
source list; relative handles include extraction. Neither measures editor opening.
Lazy views retain stored source snapshots instead of loading the edit tree.

| Method | Total edit ms | µs/copy | Edit GETs | Canonical export ms |
| --- | ---: | ---: | ---: | ---: |
| Per-key copies | 37.050 | 1157.8 | 0 | 179.7 |
| Relative handles | 0.607 | 19.0 | 0 | 176.7 |
| Lazy stored views | 0.800 | 25.0 | 0 | 370.8 |

Dropping `/tree/` and scanning `/keep` takes 1 object GET (30,984 bytes),
excluding all removed descendants. Each exported graph has 132,001 entries and
identical root digests across all trials/methods. Export makes 133 adapter `put` calls
but allocates only one new stored object: unchanged *basin nodes*[~][node] deduplicate.
This saves stored bytes, not encoding, hashing or adapter-call work.

The lazy view's cached point reads cost 2.584 µs versus 1.752 µs for its
source trie (8,192 reads after warmup); each cold point read takes 2 GETs.
Routing/async overlays add CPU overhead while preserving selective loading.
Lazy export also pays iteration, decoding and merge costs; it performs
100 source GETs here. Efficient edits do not imply efficient commits.

## COW performance

The trie core still path-copies insertions; there is no owner-tagged transient-node
mutation. Clone/Proxy payload edits can coalesce per key until a flush.

Scalar case: 100,000 values, 65,536 replacements in 64-write batches. Same immutable
core and key codec; all batch snapshots retained. Manual writes leave value ownership
to the caller. The scoped explicit case calls `set`, not `updateIn`.

| Interface | µs/replacement |
| --- | ---: |
| Manual persistent | 7.883 |
| Explicit scope | 7.555 |
| Proxy draft | 7.713 |

Nested case: 256 records, each with metadata, 64 padding records, a three-element
array and an untouched 16 KiB byte payload. Perform 4,096 metadata increments in
64-write batches after warmup; retain all 64 batch snapshots. Serialization,
consumer aggregation and storage are excluded.

| Interface | µs/update | RSS MiB after GC | Heap delta MiB |
| --- | ---: | ---: | ---: |
| Manual persistent | 6.177 | 30.0 | 1.5 |
| Explicit whole-value clone | 61.403 | 182.3 | 91.8 |
| Native clone control | 95.112 | 178.9 | 92.2 |
| Explicit path update | 7.046 | 32.8 | 1.7 |
| Proxy draft | 9.497 | 36.4 | 1.7 |

RSS includes the whole runtime; heap deltas are diagnostics, not allocation totals.
A separately instrumented 64-update batch gives:

| Interface | Cloned payload records/arrays | Copied byte payload | Proxies created | Trap calls |
| --- | ---: | ---: | ---: | ---: |
| Explicit whole-value clone | 8,704 | 2,097,152 B | 0 | 0 |
| Explicit path update | 128 | 0 B | 0 | 0 |
| Proxy draft | 128 | 0 B | 129 | 256 |

Granularity dominates: path updates and Proxies copy two records per value and share
untouched bytes. Proxy overhead is then visible against explicit path-copying,
rather than credited with the entire gain over whole-value copies. Native cloning
is a fixture-specific control, not a complete interface; notably it cannot clone
our Symbol-valued protocol data. Its input here has no symbols or shared aliases.

All scoped implementations preserve no-op root identity. Across 1,024 no-op accesses,
clone-on-edit costs 133.4 ms, the path identity updater 1.3 ms,
and Proxy field reads 3.3 ms. These are specified draft operations,
not a comparison of ordinary `get` APIs.

## Complexity and maintainability

These are judgments about this implementation, not universal Proxy costs.

| Interface | Benefit | Main cost / obligation |
| --- | --- | --- |
| Manual persistent | Minimal machinery | Caller must clone every modified branch and respect borrowed ownership. |
| Whole-value `edit` | Ordinary mutable records, arrays and bytes | Copies on entry and commit; comparison detects no-ops. Escaped working copies remain detached. |
| `updateIn` | Auditable paths; few allocations | More explicit syntax; paths/updaters currently use runtime validation and `unknown` leaf types. |
| Proxy draft | Natural nested writes and typed fields | Reflection, arrays, revocation, key codecs and byte facades add machinery and restrictions. |

The explicit engine is 335 source lines including shared value helpers;
Proxy support adds 289 lines and two nine-trap handler surfaces. Counts include
comments/blank lines; extra path-update code is already in the explicit engine.

Records have value semantics, not prototype or JavaScript alias-identity guarantees.
Both validate supported value shapes, protect assigned values, detach or revoke
escaped drafts, discard failed recipes and support asynchronous recipes. Proxy byte
reads expose a read-only facade; replacement accepts `Uint8Array`, but downstream
code expecting a real typed array must obtain an owned value/slice. Serialize the
returned editor, not draft facades. Paths and property strings have explicit hex/
UTF-8 codecs; UTF-8 requires well-formed strings. Byte copies normalize Buffer
inputs to plain `Uint8Array`: Buffer `slice` aliases and cannot establish ownership.

Browser-target ESM, full exported APIs, no source maps; gzip level 9:

| Profile | JS lines | Minified bytes | gzip bytes | Incremental minified bytes |
| --- | ---: | ---: | ---: | ---: |
| base | 2,400 | 45,870 | 14,541 | 0 |
| view | 2,621 | 50,326 | 15,709 | 4,456 |
| explicit | 2,625 | 50,588 | 15,987 | 4,718 |
| proxy | 2,868 | 54,620 | 17,043 | 8,750 |
| all | 3,093 | 59,151 | 18,272 | 13,281 |

Base includes `Basin`, memory storage, trie/editor and logical prefix operations.
Optional profiles add views, explicit scopes, Proxy scopes, or all three. These
include shared framing/integrity machinery; differences are whole-bundle sizes.

## Boundaries and verification

Views are ephemeral routing plans; canonical export still scans/repacks everything.
Local handles do not change server retention; source objects must remain available.
They add cached-read overhead and enforce a shared storage/consumer context. The
logical editor caps `size` at safe integers and may rebuild a 255-entry boundary
leaf. Neither interface supplies filesystem policy or a new stored schema. Generic
consumer aggregation retains its existing full-key/flat-order semantics.

161 tests pass, including randomized splice/model comparisons, descendant sharing,
excluded-fetch counts, root identity, snapshot/escape/async safety, reflection,
arrays, symbols, malformed text, count overflow and Buffer ownership. 234 cross-language
cases and live storage/promotion/restart integration pass; the *browser smoke*[~][cow-browser-smoke]
also covers frozen inputs, reflection, revocation and stored framing/crypto. Canonical output is
unchanged; Rust/Go gain no new edit APIs in this pass.

```sh
bun scripts/benchmark-subtree-cow.ts
bun scripts/measure-cow-size.ts
```

`SUBTREE_COW_N` (at least 6400), `SUBTREE_COW_ROUNDS`, `SUBTREE_COW_MODES` and
`SUBTREE_COW_OUT` select runs. Fixture shapes and source fingerprints are in the raw
results. Confidence is high in tested semantics, moderate in extending the performance
recommendation beyond these workloads/runtime. Next, target selective canonical
export rather than making Proxies the default.
