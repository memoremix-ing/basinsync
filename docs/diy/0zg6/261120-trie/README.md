---
prerequisites:
  - 0zg5/261112-deep-heap-support
---

[access-token]: <../../../glossary/access-token.md>
[envbuf]: <../../../glossary/envbuf.md>
[flexbuffers]: <../../../glossary/flexbuffers.md>
[heap]: <../../../glossary/heap.md>
[json0]: <../../../glossary/json0.md>
[node]: <../../../glossary/node.md>
[node-degree]: <../../../glossary/node-degree.md>
[node-height]: <../../../glossary/node-height.md>
[strong-edge]: <../../../glossary/strong-edge.md>
[weak-link]: <../../../glossary/weak-link.md>

# Tries and shortcut links — design discussion

Explore versioned data structures for storage and incremental loading from
basinsync. Distinguish *basin nodes*[~][node] and their *basin edges*[~][strong-edge]
from logical trie nodes. Serialize each stored *basin node*[~][node] as an
*EnvBuf*[~][envbuf] wrapping a *FlexBuffer*[~][flexbuffers].

The proposal combines compressed byte keys, two nibble levels for 256-way
branching, small sorted key/value groups, and consumer-defined summaries.
Replicated headers and summaries permit pruning before fetching a target.
Values stay at their ordinary trie positions; hashing belongs to consumer
aggregation. The declarations below preserve the proposal verbatim for refinement.

## Basin nodes and edges

```ts
type U32 = number;

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
  0: typeof Symbol.species;
  1: DomainT;
  2: PathT;
  3: BasinQuery_S0;
  4: SCHEMA_0;
  5: HeaderT;
  6: {
    [IndexT in U32 & keyof FootersT]: [IndexT, ...FootersT[IndexT]];
  }[U32 & keyof FootersT];
}

type BasinQuery_S0 = {
  height: U32; // (for DAG inaviants and basin ids)
  degree: U32; // shallow count of edges
  breadth: bigint; // deep aggregate degree
  rotations: [floor: U32, ceiling: U32]; // deep aggregate from edges
  versions: [floor: U32, ceiling: U32]; // deep aggregate from edges
  schemas: [floor: U32, ceiling: U32]; // deep aggregate over edges
  migrations: [floor: U32, ceiling: U32]; // deep aggregate over edges
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
> = [
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

## Trie layout

```ts
interface TrieNode_S0<
  MigrationsT extends {
    [index: number]: { Summary: unknown; Value: unknown };
  },
> extends BasinNode_S0<
  "sync.memoremix.com",
  ".trie-node/",
  {
    edition: bigint; // (inherited from ancestors, incremented at root after every update)
    count: bigint; // number of values
    nullity: bigint; // number of values that are null
    degree: U32; // number of trie-handles (distinct from basin-degree)
    inlined: U32; // count of nested values up to edge boundaries
    prefix: null | Uint8Array; // (for trie-compression)
    keys: [floor: Uint8Array, ceiling: Uint8Array];
    reversals: [floor: Uint8Array, ceiling: Uint8Array]; // min/max reverse-key
    lengths: [floor: U32, ceiling: U32]; // min/max key-lengths
  },
  {
    [IndexT in U32 & keyof MigrationsT]: [
      summary: MigrationsT[IndexT]["Summary"],
      // (must not have common byte-prefix -- extract that to the header)
      group: TrieGroup<MigrationsT[IndexT]["Value"]>,
      // (present when initial group overflows -- will hold all values except where key ends at prefix)
      ...nest: TrieNest<MigrationsT, IndexT>,
    ];
  }
> {}

interface TrieGroup<ValueT> {
  keys: Array<Uint8Array>; // 63 maximum
  values: Array<ValueT>; // (one per key)
}

type TrieNest<
  MigrationsT extends {
    [index: number]: { Summary: unknown; Value: unknown };
  },
  IndexT extends U32 & keyof MigrationsT,
> =
  | [members: null, edged: null]
  | [
      members: Array<
        // 16 maximum (i.e. one per nibble)
        | null
        | TrieGroup<MigrationsT[IndexT]["Value"]> // (must have common nibble-prefix)
        | Array<
            // 16 maximum (i.e. one per nibble)
            null | TrieNode_S0<MigrationsT>
          >
      >,
      edged: false, // (when nested nodes have no corresponding edges -- default unless inlined > 1280)
    ]
  | [
      members: Array<
        // 16 maximum (i.e. one per nibble)
        | null
        | TrieGroup<MigrationsT[IndexT]["Value"]> // (must have common nibble-prefix)
        | Array<
            // 16 maximum (i.e. one per nibble)
            null | BasinEdge_S0<TrieNode_S0<MigrationsT>>
          >
      >,
      edged: true, // (when no nodes are directly inlined members)
    ];

```

## Volume and directory shortcuts

```ts
interface SyncVolume_S0 extends BasinNode_S0<
  "sync.memoremix.com",
  ".sync-volume/",
  null,
  {
    0: [
      summary: null,
      device: TrieNode_S0<{
        0: {
          Summary: null;

          Value: [edge: BasinEdge_S0<SyncBlock_M0>];
        };
      }>,
      root: SyncDirectory_M0,
    ];
  }
> {}

type SyncDirectory_M0 = [
  folder: true,
  sha384: Uint8Array, // (digest of lexicographically ordered contents' own digests concatenated together)
  contents: {
    [basename: string]: SyncDirectory_M0 | SyncFile_M0;
  },
];

type SyncFile_M0 = [
  folder: false,
  brombergSL2: Uint8Array, // (cache of linked block's own digest)
  link: SyncLink_M0<SyncBlock_M0>,
];

type SyncLink_M0<LazyT extends BasinNode_S0<string, string>> = {
  height: U32;
  version: U32;
  entropy: Uint8Array;

  [Symbol.unscopables]?: LazyT;
};

```

## Blocks and sectors

```ts
interface SyncBlock_M0 extends BasinNode_S0<
  "sync.memoremix.com",
  ".sync-volume/",
  null,
  {
    0: [
      summary: null,
      // (lexidecmal trie keys encoded from sparse page numbers)
      pages: SyncSector_M0,
      // (sorted for binary search)
      leaves: Array<
        [page: bigint, span: U32, link: SyncLink_M0<SyncSector_M0>]
      >,
    ];
  }
> {}

type SyncSector_M0 = TrieNode_S0<{
  0: {
    Summary: {
      brombergSL2: Uint8Array; // homomorphic checksum over the blobs in the page range
    };

    Value: [data: Uint8Array];
  };
}>;
```

## Review notes

The overall separation is promising: bounded groups keep small subtries local,
edge descriptors expose pruning metadata, and footer variants distinguish consumer
migrations from the structural schema. A few decisions need sharpening:

- **Wire shape.** Numeric-property interfaces accept both objects and arrays,
  which our *FlexBuffers*[~][flexbuffers] writer encodes differently. Specify
  vectors versus maps explicitly, including the mixed numeric/named edge footer.
  `Symbol.match` currently fails our *JSON0*[~][json0] and
  *FlexBuffers*[~][flexbuffers] symbol allowlists. Keep lazy caches out of serialized data.
- **Versions.** Define the roles of slot 4, the selected slot-6 footer tag, and
  `footer.version` separately: structural schema, consumer migration, and
  *basin-node*[~][node] id version. Slot 6 currently selects one variant, rather
  than storing several footers. Specify whether footer tags are dense ordinals or
  stable identifiers, how readers handle unknown versions, and how nodes of
  different migrations coexist. The `SyncBlock_M0` path repeats `.sync-volume/`;
  it appears to need its own discriminator.
- **Packing.** Sixteen by sixteen slots permit 256 distinct *basin edges*[~][strong-edge],
  exceeding both the earlier 240 target and the current default
  *degree limit*[~][node-degree] of 128. Specify sorted/unique group keys, equal
  key/value lengths, slot numbering and trailing-null rules. Make packing a
  function of contents, not insertion history; define the 63-value and 1280-inline
  transitions, root exceptions, and whether `edged` switching makes every nested
  sibling a separate *basin node*[~][node]. Value-count limits do not bound bytes.
  Readers need runtime validation: `U32 = number` and unrestricted arrays do not
  enforce numeric bounds, capacities, or parallel-array lengths.
- **Prefixes.** Define whether group keys are full keys or suffixes and which
  nibbles each nesting level consumes. A `Uint8Array` header prefix cannot express
  an odd nibble count alone; either compress whole bytes only or carry the count.
  Distinguish an empty key, a key ending at the prefix, and a null value.
- **Aggregates and reuse.** Define empty ranges, inclusive/exclusive ceilings,
  whether ranges include the current node, and whether deep counts include shared
  descendants repeatedly. *Height*[~][node-height] follows *basin edges*[~][strong-edge],
  not inline trie nesting. An inherited `edition` should be traversal context, or
  describe when a node changed; requiring every stored descendant to match a new
  root edition would defeat subtree reuse.

## Strong retention and weak shortcuts

Use *strong basin edges*[~][strong-edge] as the retention graph declared to the
*Heap*[~][heap]. A *weak link*[~][weak-link] supplies a shortcut without adding a
retainer. The volume's `device` trie can strongly retain file blocks, while its
adjacent directory tree links directly to those blocks; each block can similarly
cache direct links to sector roots/leaves. Reads can follow shortcuts immediately,
without first traversing the retaining trie. Its strong references still need
explicit declaration to basinsync; serializing them inside opaque values does
not establish retention.

Tie shortcut data to the same trusted root/version and validate its expected
identity. Missing or stale shortcuts fall back to the authoritative trie; a
missing strongly retained target is a different failure. *Weak links*[~][weak-link]
must not contribute to retention *degree*[~][node-degree] or
*height*[~][node-height], nor be accidentally collected as declared edges.
Their address may still carry the target's *height*[~][node-height].

The shortcut layout itself needs a size boundary: an entirely inline directory
tree or `leaves` array can grow without bound. Partitioning or partial caches
can preserve direct access without duplicating the whole index at every root.
The proposed directory digest also omits basenames: renaming a sole child leaves
it unchanged. Its consumer-defined digest should cover names, entry kinds, and
unambiguous framing if it is meant to identify directory contents.

Before choosing a shortcut layout, measure first-useful-result latency, fetched
bytes, request count, and update churn against ordinary trie traversal. Keep
content identity and consumer aggregation independent of allocation details.
