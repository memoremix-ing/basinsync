---
prerequisites:
  - 0zg5/261112-deep-heap-support
---

[diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie]: <0zg7/261120-byte-trie/README.md>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261123-b-tree]: <0zg7/261123-b-tree/README.md>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261123-bitmapped-vector-trie]: <0zg7/261123-bitmapped-vector-trie/README.md>
[envbuf]: <../../../glossary/envbuf.md>
[flexbuffers]: <../../../glossary/flexbuffers.md>
[node]: <../../../glossary/node.md>
[node-degree]: <../../../glossary/node-degree.md>
[node-format]: <../../../node-format.md>
[revision]: <../../../glossary/revision.md>
[strong-edge]: <../../../glossary/strong-edge.md>

# Basin node standard library

Build versioned data structures for storage and incremental loading from basinsync.
Distinguish logical structure nodes from stored *basin nodes*[~][node]. Use
numeric-keyed *FlexBuffers maps*[~][flexbuffers] in *EnvBufs*[~][envbuf];
*basin edges*[~][strong-edge] are `Symbol.match` vectors, with allocation
*revisions*[~][revision] for direct shared-storage addressing.

Replicate bounds and consumer summaries across *basin edges*[~][strong-edge] so
readers can prune without fetching. Content hashing is consumer-defined; stored-node integrity checks remain independent. Structural
schema, consumer migration and node-id version remain independent.
`breadth` and `weight` are approximate and may count shared descendants repeatedly.
The default physical *degree limit*[~][node-degree] is 320.

```ts
type U32 = number;

// null denotes no observations; nonempty bounds include both ends.
type Bounds<T> = null | [floor: T, ceiling: T];

type SCHEMA_0 = 0;

type Footers = {
  [index: number]: [summary: unknown, ...data: Array<unknown>];
};

interface BasinNode_S0<
  DomainT extends string,
  PathT extends string,
  HeaderT = any,
  FootersT extends Footers = any,
> {
  [Symbol.iterator]?: never; // FlexBuffers map, not a vector
  0: typeof Symbol.species;
  1: DomainT;
  2: PathT;
  3: BasinQuery_S0;
  4: SCHEMA_0; // structural schema, independent of consumer migration
  5: HeaderT;
  6: {
    [IndexT in U32 & keyof FootersT]: [migration: IndexT, ...FootersT[IndexT]];
  }[U32 & keyof FootersT];
}

type BasinQuery_S0 = {
  height: U32; // (for DAG invariants and basin ids)
  degree: U32; // shallow count of edges
  breadth: bigint; // approximate deep degree; shared descendants may contribute repeatedly
  rotations: Bounds<U32>; // deep aggregate from edges
  versions: Bounds<U32>; // deep aggregate from edges
  schemas: Bounds<U32>; // deep aggregate over edges
  migrations: Bounds<U32>; // deep aggregate over edges
};

type BasinEdge_S0<
  LazyT extends BasinNode_S0<string, string>,
  HeaderT = LazyT[5],
  FootersT extends {
    [IndexT in U32 & LazyT[6][0]]: [unknown, ...Array<unknown>];
  } = {
    [IndexT in U32 & LazyT[6][0]]: Extract<
      LazyT[6],
      [IndexT, ...unknown[]]
    > extends [IndexT, infer TSummary, ...infer TData]
      ? [TSummary, ...TData]
      : never;
  },
> = [ // FlexBuffers vector; its footer is a map
  protocol: typeof Symbol.match,
  domain: LazyT[1],
  path: LazyT[2],
  query: LazyT[3],
  schema: { 0: SCHEMA_0 }[LazyT[4]],
  header: HeaderT,
  footer: {
    [IndexT in U32 & keyof FootersT]: {
      0: IndexT;
      1: FootersT[IndexT][0];

      version: U32; // node-id encoding version number
      revision: string; // UUIDv4 allocation revision in the shared heap
      length: U32; // shallow byte-length of basin-node in object storage
      weight: bigint; // deep approximate byte-length of basin-node graph in object storage (may include duplicates)
      sha384: Uint8Array; // digest of basin-node in object storage
      entropy: Uint8Array; // 256-bits of confidential key material for HKDFing a token, secret, and nonce
      rotation: U32; // KMS-specific hint of the key for the root that introduced the referenced node

      [Symbol.unscopables]?: LazyT; // lazy-loaded (never embedded in serializations)
    };
  }[U32 & keyof FootersT],
];

```

*Byte trie and volume*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie].

*Bitmapped vector trie*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261123-bitmapped-vector-trie].

*B-tree*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261123-b-tree].

The *format reference*[~][node-format] records shared capability derivation and storage conventions.

These codecs serialize plaintext; encryption needs a separate storage representation.

## Implementation considerations

- Measure logical construction/traversal separately from packing, serialization,
  integrity hashing and storage. Compare matching capabilities, not just method names.
- Bisect costs with coarse feature controls, then isolate changes and their
  interactions. Use repeated fresh-process trials and sufficiently long read loops.
- Exploit sorted input: derive bounds from endpoints and partition once instead of
  repeatedly filtering. Prefer offsets/ranges to temporary suffix allocations,
  while retaining ownership at public input boundaries.
- Cache immutable parsed lookup metadata; preserve validation of mutable or
  untrusted descriptors. Let synchronous work stay synchronous, suspending when
  loading actually requires it.
- Separate path-copied logical edits from canonical export; measure both. Preserve
  consumer callback semantics when caching or regrouping summaries.
- Inspect actual serialized widths and bytes: lengths, values and relative offsets
  can each widen representations. Keep optional expensive summaries consumer-defined.
- For format-preserving optimizations, compare serialized bytes and cross-language
  reads, including uncached loads, snapshots, prefixes and packing boundaries.
