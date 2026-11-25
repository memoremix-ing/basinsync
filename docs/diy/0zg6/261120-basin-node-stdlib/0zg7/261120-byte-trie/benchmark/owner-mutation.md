[diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie]: <../README.md>
[owner-browser-smoke]: <owner-browser-smoke.json>
[owner-chart]: <owner-chart.html>
[owner-fair]: <owner-fair.json>
[owner-owned-metadata]: <owner-owned-metadata.json>
[owner-summary]: <owner-summary.csv>
[owner-tags]: <owner-tags.json>

# Owner-tagged mutation

Apple M2 / Bun 1.4.5; five fresh processes per case, alternating persistent/owned
order. CPU editing only: no serialization, aggregation, crypto or storage. Retain
every returned snapshot. Compare modes at the same batch size; changing batch size
also changes snapshot frequency. RSS is whole-process after GC, not allocation size.
Source fingerprints accompany the *tag-only runs*[~][owner-tags],
*owned metadata experiment*[~][owner-owned-metadata], *matched incremental
controls*[~][owner-fair] and *summary*[~][owner-summary]. Reproduce with
`bun scripts/benchmark-owner-trie.ts`; `OWNER_OUT` and `OWNER_ROUNDS` select output
and repetition count.

Scalar: 100,000 existing entries, 65,536 replacements. Nested: 256 records, 4,096
increments to `meta.n`, retaining an untouched 16 KiB byte field and 64 padding
records. Core callers provide immutable values; COW path/Proxy APIs also enforce
payload ownership. All cases verify output and earlier snapshots.

## Attribution

Owner tags alone changed 64-edit medians by only a few percent: both versions still
scanned every child to recalculate branch counts/heights. Updating owned metadata
incrementally gave a much larger gain, but that improvement also applies to
persistent edits. The final comparison applies incremental metadata to both;
only ownership/reuse differs. Stage-to-stage percentages are less controlled than
the alternating comparisons within a stage.

*Interactive batch comparison*[~][owner-chart]. Final medians, 64 edits/snapshot, microseconds per update:

| Workload / API | Persistent | Owned | Speedup |
| --- | ---: | ---: | ---: |
| scalar / core | 1.37 | 0.67 | 2.03× |
| scalar / path | 1.49 | 0.88 | 1.69× |
| scalar / proxy | 1.54 | 0.92 | 1.67× |
| nested / core | 1.87 | 1.39 | 1.34× |
| nested / path | 2.44 | 2.25 | 1.08× |
| nested / proxy | 5.06 | 4.41 | 1.15× |

For scalar COW batches, ownership is about 1.7× faster. Nested payload work dilutes
that gain. One-edit scopes are slower with ownership; at 1,024 edits the nested
Proxy result is approximately tied. Keep ownership opt-in, especially when drafts
already coalesce multiple payload writes into one structural update.

One 64-write scalar batch claims 67 nodes and reuses owned nodes 189 times; nested
batches claim 65 and reuse 63. Payload-copy counts match between modes. Ownership
counters exclude canonical rebuild allocations; zero counters on persistent
controls mean uninstrumented, not allocation-free. RSS does not consistently fall.

## Scope boundaries

Use the *COW APIs*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie]
with `mutation: "owned"`, or `editor.mutate()` for borrowed immutable payloads.
Point edits reuse owned row/child arrays; snapshots, escaped iterators and prefix
splices rotate ownership before sharing. Prefix split/graft still use persistent
boundary repair. No serialized schema changes; export remains a full canonical pass.

The implementation adds a structural point-edit path and a private-token builder;
canonical normalization and metadata bookkeeping are shared with persistent edits.
Tests cover duplicated subtree aliases, old snapshots, aborts, closed handles,
concurrent async recipes, deep height shrinkage and matching canonical exports.
A *browser smoke check*[~][owner-browser-smoke] also passes frozen Proxy inputs,
snapshot isolation, revocation, concurrent async scopes and stored readback. These
measurements establish neither browser CPU performance nor Rust/Go gains.
