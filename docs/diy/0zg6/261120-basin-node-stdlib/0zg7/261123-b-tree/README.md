---
prerequisites:
  - 0zg6/261120-basin-node-stdlib
  - 0zg6/261112-commit-marker-edges-with-node-promotion
---

[diy/0zg6/261120-basin-node-stdlib]: <../../README.md>
[editor-reads]: <benchmark/editor-reads.md>
[node-height]: <../../../../../glossary/node-height.md>
[strong-edge]: <../../../../../glossary/strong-edge.md>

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
borrowing/merging on deletion. Canonical export still rebuilds from contents.

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
selective export and native logical editors remain separate work.

The *edit/read measurements*[~][editor-reads] separate callback awaits from lookup
changes and report logical editing independently of export.
