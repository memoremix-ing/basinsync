---
prerequisites:
  - 0zg6/261120-basin-node-stdlib
  - 0zg6/261112-commit-marker-edges-with-node-promotion
---

[bplus]: <benchmark/bplus.md>
[diy/0zg6/261120-basin-node-stdlib]: <../../README.md>
[editor-reads]: <benchmark/editor-reads.md>
[node-height]: <../../../../../glossary/node-height.md>
[selective-ordered]: <../../benchmark/selective-ordered.md>
[strong-edge]: <../../../../../glossary/strong-edge.md>
[weak-link]: <../../../../../glossary/weak-link.md>

# B-tree

Use the *shared node/edge contract*[~][diy/0zg6/261120-basin-node-stdlib] and
TypeScript, Rust and Go storage callbacks.

Store byte/whole-hex keys and generic values in a balanced, ordered tree.
Every node has up to 31 key/value pairs and 32 children. Branch keys retain their
actual values, so a matching separator is readable before descending.
Non-root nodes have at least 15 pairs; leaves share a logical depth.

Canonical bulk construction chooses the least depth fitting `n <= 32^(depth+1)-1`.
At each branch choose the fewest children allowed by that capacity (at least two
at the root, sixteen elsewhere). Distribute remaining rows evenly among children,
giving the first remainder children one extra row, and take intervening rows as
separator key/value pairs. Canonical export uses this construction, collapsing roots.

Aggregate in full key order; mirror count, inclusive key bounds and consumer
summaries across *basin edges*[~][strong-edge]. Range scans include their start
and exclude their end; aggregate pruning can reject targets before fetching.
Pack children inline up to 1280 values and the physical degree limit, then seal
all immediate children. Logical `depth` and *basin-node height*[~][node-height]
remain distinct. In-memory edits path-copy branches, splitting overflow and
borrowing/merging on deletion. Export reuses aligned unchanged subtrees for
explicitly composable consumers; rank shifts may require wider repacking.

```ts
interface BTreeNode_S0<
  MigrationsT extends { [index: number]: { Summary: unknown; Value: unknown } },
> extends BasinNode_S0<
    "sync.memoremix.com",
    ".btree-node/",
    { count: bigint; depth: U32; inlined: U32; keys: Bounds<Uint8Array> },
    {
      [I in U32 & keyof MigrationsT]: [
        summary: MigrationsT[I]["Summary"],
        keys: Array<Uint8Array>,
        values: Array<MigrationsT[I]["Value"]>,
        children: null | Array<
          BTreeNode_S0<MigrationsT> | BasinEdge_S0<BTreeNode_S0<MigrationsT>>
        >,
      ];
    }
  > {}
```

```js
const tree = await BTree.build(basin, [["abcd", value]], consumer);
const found = await tree.get("abcd");
for await (const [key, value] of tree.entries("ab", "ac")) use(key, value);
const edited = (await tree.edit()).set("abce", otherValue).delete("abcd");
const next = await edited.store();
const ready = next.getOrDefer("abce"); // value, or lazy generator for missing I/O
```

Check empty/threshold cases, independent snapshots, canonical rebuilds, sparse or
separator lookups, range/aggregate pruning, corrupted descriptors, and all three
languages reading one another's fixtures.

TypeScript caches parsed lookup plans and suspends at missing edges; ready reads
need no Promise. Edits retain old snapshots without aggregation, hashing or I/O.
Keys are owned, values borrowed. Loading an editor materializes its contents;
native logical editors remain separate work.

The *edit/read measurements*[~][editor-reads] separate callback awaits from lookup
changes and report logical editing independently of export.

## B+tree comparison

The TypeScript prototype keeps values in leaves and copies each right child's
minimum key into its parent. Build balanced leaves first, then balanced branch
levels; input order does not affect packing. Defaults are 127 pairs per leaf,
128 children per branch, 1,280 inline values and 8,192 inline routing keys.
These four budgets are independently configurable. Seal immediate children when
either inline budget or the physical degree limit is exceeded.

Only the root carries optional leading/lagging *weak hints*[~][weak-link], indexed
by stored *basin-node height*[~][node-height], with target bounds and SHA-384.
Validate capability, digest and bounds before using one; fall back to strong
traversal. Leaf keys own their values; equal separator keys descend right.
Branches contain null values, leaves null children. Generic summaries aggregate
in full key order; duplicate separator copies do not contribute.

```ts

interface BPlusNode_S0<
  MigrationsT extends { [index: number]: { Summary: unknown; Value: unknown } },
> extends BasinNode_S0<
  "sync.memoremix.com", ".bplus-node/",
  {
    count: bigint; depth: U32; inlined: U32; routing: U32; keys: Bounds<Uint8Array>;
    policy: { leafKeys: U32; branchChildren: U32; leafInline: U32; branchInline: U32 };
  },
  {
    [I in U32 & keyof MigrationsT]: [
      summary: MigrationsT[I]["Summary"],
      keys: Array<Uint8Array>,
      values: null | Array<MigrationsT[I]["Value"]>,
      children: null | Array<BPlusNode_S0<MigrationsT> | BPlusEdge_S0<MigrationsT>>,
      leading: Array<null | BPlusHint_S0<MigrationsT>>,
      lagging: Array<null | BPlusHint_S0<MigrationsT>>,
    ];
  }
> {}

type BPlusEdge_S0<
  MigrationsT extends { [index: number]: { Summary: unknown; Value: unknown } },
> = BasinEdge_S0<BasinNode_S0<
  "sync.memoremix.com", ".bplus-node/", BPlusNode_S0<MigrationsT>[5],
  { [I in U32 & keyof MigrationsT]: [summary: MigrationsT[I]["Summary"]] }
>>;

type BPlusHint_S0<
  MigrationsT extends { [index: number]: { Summary: unknown; Value: unknown } },
> = {
  keys: [Uint8Array, Uint8Array];
  link: SyncLink_M0<BPlusNode_S0<MigrationsT>>;
  sha384: Uint8Array;
};
```

```js
const tree = await BPlusTree.build(basin, rows, consumer, {
  leafKeys: 127, branchChildren: 128, leafInline: 1280, branchInline: 8192,
});
const value = await tree.get(key, { shortcuts: true });
```

This is a build/read/range comparison, not a replacement default. Logical editing
and native readers for this experimental species remain separate work.

The *selective export measurements*[~][selective-ordered] distinguish adapter calls
from new objects. The *B+tree comparison*[~][bplus] varies leaf size, fanout and
routing/value budgets independently; physical packing dominates logical depth.
