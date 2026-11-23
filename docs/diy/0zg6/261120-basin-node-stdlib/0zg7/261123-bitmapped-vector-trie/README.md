---
prerequisites:
  - 0zg6/261120-basin-node-stdlib
  - 0zg6/261112-commit-marker-edges-with-node-promotion
---

[diy/0zg6/261120-basin-node-stdlib]: <../../README.md>
[node-height]: <../../../../../glossary/node-height.md>
[strong-edge]: <../../../../../glossary/strong-edge.md>

# Bitmapped vector trie

Use the *shared node/edge contract*[~][diy/0zg6/261120-basin-node-stdlib] and
TypeScript, Rust and Go storage callbacks.

Index generic values with nonnegative bigint positions and a logical `length`;
absent slots are holes, distinct from stored nulls. Each level consumes five bits.
A scalar u32 bitmap selects packed slots in ascending position; rank counts lower
set bits. Leaves (`shift = 0`) contain values; branches contain inline nodes or
*basin edges*[~][strong-edge]. Bit 31 must survive signed host bit operations.

Build the smallest root shift covering `length`. Omit empty subtrees; an empty
root retains its length with count/bitmap zero. Aggregate present values in index
order; consumer entry callbacks receive canonical unsigned big-endian index bytes
(zero is one zero byte). Replicate span/count and summaries across
*basin edges*[~][strong-edge] for range and aggregate pruning.

Pack children inline while `inlined <= 1280` and the physical degree fits; otherwise
seal all immediate children. `shift` counts logical bit levels, independently of
*basin-node height*[~][node-height]. A range includes its start and excludes its end.
Updates, append and pop currently rebuild canonically, preserving earlier roots.

```ts
interface VectorNode_S0<
  MigrationsT extends { [index: number]: { Summary: unknown; Value: unknown } },
> extends BasinNode_S0<
    "sync.memoremix.com",
    ".vector-node/",
    { length: bigint; count: bigint; shift: U32; inlined: U32 },
    {
      [I in U32 & keyof MigrationsT]: [
        summary: MigrationsT[I]["Summary"],
        bitmap: U32,
        slots: Array<
          | MigrationsT[I]["Value"]
          | VectorNode_S0<MigrationsT>
          | BasinEdge_S0<VectorNode_S0<MigrationsT>>
        >,
      ];
    }
  > {}
```

```js
const vector = await Vector.build(basin, ["a", null, "c"], consumer);
const next = await vector.push("d");
const sparse = await Vector.buildEntries(basin, 2n ** 200n + 1n,
  [[2n ** 200n, value]], consumer);
const found = await sparse.get(2n ** 200n);
```

Check empty/threshold cases, independent snapshots, canonical rebuilds, sparse or
separator lookups, range/aggregate pruning, corrupted descriptors, and all three
languages reading one another's fixtures.
