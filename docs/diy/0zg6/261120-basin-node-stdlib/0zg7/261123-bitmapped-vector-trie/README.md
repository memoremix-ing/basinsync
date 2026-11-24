---
prerequisites:
  - 0zg6/261120-basin-node-stdlib
  - 0zg6/261112-commit-marker-edges-with-node-promotion
---

[comparison]: <benchmark/comparison.md>
[diy/0zg6/261120-basin-node-stdlib]: <../../README.md>
[incremental-edits]: <benchmark/incremental-edits.md>
[node-height]: <../../../../../glossary/node-height.md>
[strong-edge]: <../../../../../glossary/strong-edge.md>

# Bitmapped vector trie

Use the *shared node/edge contract*[~][diy/0zg6/261120-basin-node-stdlib] and
TypeScript, Rust and Go storage callbacks.

Index generic values with nonnegative bigint positions and a logical `length`;
absent slots are holes, distinct from stored nulls. Consumers choose `bits` from
1–8 (default 5), giving 2–256 slots per logical node. Persist that choice in every
header. A packed LSB-first bitmap blob selects slots in ascending position;
its byte length is `ceil(2**bits / 8)`, with unused bits zero. Rank counts lower
set bits. Use `VT_BLOB`, preserving `VT_VECTOR_UINT` for extensions.
Leaves (`shift = 0`) contain values; branches contain inline nodes or
*basin edges*[~][strong-edge].

Build the smallest root shift covering `length`. Omit empty subtrees; an empty
root retains its length with count/bitmap zero. Aggregate present values in index
order; consumer entry callbacks receive canonical unsigned big-endian index bytes
(zero is one zero byte). Replicate span/count and summaries across
*basin edges*[~][strong-edge] for range and aggregate pruning.

Pack children inline while `inlined <= 1280` and the physical degree fits; otherwise
seal all immediate children. Multiple logical vector levels can therefore share
one stored *basin node*[~][strong-edge], just as with the byte trie. A logical
child does not necessarily require a GET. `shift` counts bit levels, independently of
*basin-node height*[~][node-height]. A range includes its start and excludes its end.
Stored updates, append and pop rebuild canonically, preserving `bits`. TypeScript also offers
synchronous, path-copied logical editors, preserving earlier snapshots:

```ts
interface VectorNode_S0<
  MigrationsT extends { [index: number]: { Summary: unknown; Value: unknown } },
> extends BasinNode_S0<
    "sync.memoremix.com",
    ".vector-node/",
    { length: bigint; count: bigint; bits: U32; shift: U32; inlined: U32 },
    {
      [I in U32 & keyof MigrationsT]: [
        summary: MigrationsT[I]["Summary"],
        bitmap: Uint8Array, // LSB-first packed bits; exactly ceil(2**bits / 8) bytes
        slots: Array<
          | MigrationsT[I]["Value"]
          | VectorNode_S0<MigrationsT>
          | VectorEdge_S0<MigrationsT>
        >,
      ];
    }
  > {}

// Spell out the edge summary to avoid expanding the recursive node footer.
type VectorEdge_S0<
  MigrationsT extends { [index: number]: { Summary: unknown; Value: unknown } },
> = BasinEdge_S0<
  BasinNode_S0<
    "sync.memoremix.com",
    ".vector-node/",
    VectorNode_S0<MigrationsT>[5],
    {
      [I in U32 & keyof MigrationsT]: [summary: MigrationsT[I]["Summary"]];
    }
  >
>;
```

```js
const vector = await Vector.build(basin, ["a", null, "c"], consumer, { bits: 7 });
const next = await vector.push("d");
const sparse = await Vector.buildEntries(basin, 2n ** 200n + 1n,
  [[2n ** 200n, value]], consumer);
const found = await sparse.get(2n ** 200n);
```

```js
let edit = await vector.edit(); // materializes existing contents once
const prior = edit;
edit = edit.push(value).set(31n, replacement);
const stored = await edit.store(); // full canonical packing, aggregation and hashing
```

`VectorEditor.from(basin, length, entries, consumer, { bits: 7 })` starts without
stored data. Edits/export preserve the chosen width. Rust offers `build_with_bits`
and `build_entries_with_bits`; Go accepts a final optional bit count.
Keep values immutable; keys/structure are owned. Logical edits do no storage or
aggregation. Export remains a full pass, rather than selective stored-node rewriting.
Cached reads retain parsed lookup plans and defer only missing loads; consume index
digits once instead of repeating bigint remainder operations at every level.
See the *incremental-edit and vector measurements*[~][incremental-edits].

Check empty/threshold cases, independent snapshots, canonical rebuilds, sparse or
separator lookups, range/aggregate pruning, corrupted descriptors, and all three
languages reading one another's fixtures.

Compare incrementing positions with the byte trie and historical collection in the
*client performance and browser-size measurements*[~][comparison].
