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
aggregation. The declarations below track the proposal for refinement.

*Basin nodes*[~][node] are *FlexBuffers maps*[~][flexbuffers], with string keys
`"0"` through `"6"`. *Basin edges*[~][strong-edge] are vectors; their footer
descriptor remains a map. `Symbol.match` identifies an edge in both
*JSON0*[~][json0] and *FlexBuffers*[~][flexbuffers]. The default
*basin-edge degree limit*[~][node-degree] is 320.

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
  [Symbol.iterator]?: never; // FlexBuffers map, not a vector
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
  sha384: Uint8Array, // digest of UTF-8 basename-byte-sorted pairs: length-framed basename + child digest
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
  ".sync-block/",
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

## Open design questions

- **Version labels.** Slot 4 identifies the structural schema; the first element
  of slot 6 selects the consumer migration; an edge footer's `version` identifies
  the *basin-node*[~][node] id encoding. For example, structural schema 0 can
  carry migration 7 while still referencing node-id version 0. Are migration
  labels permanent identifiers, so deleting migration 1 never renumbers 2?
  Slot 6 currently stores one selected migration, not all footer variants.
- **Key consumption.** For key bytes `ab cd`, a branch can consume nibble `a`
  then nibble `b`, leaving suffix `cd`. Specify whether groups store that suffix
  or the full key. The proposal already calls for common byte-prefix compression,
  which fits `Uint8Array`; no extra nibble count is needed. Define how a key
  ending at the prefix is stored.
- **Deterministic packing.** Inserting 64 keys and then deleting one should
  produce the same representation as inserting the remaining 63 directly.
  Specify collapse as well as split rules, indexed nibble slots and omitted/null
  slots, and the 1280-inline transition. Does `edged: true` externalize every
  nested sibling, even a small one? *Degree*[~][node-degree] 320 accommodates the
  256 structural slots, but value count alone does not bound serialized bytes.
  Runtime readers still validate integer bounds, capacities, unique/sorted keys,
  and equal key/value array lengths.
- **Aggregate meaning.** For a shared child reached by two paths, is its
  contribution counted twice in `breadth`? Specify whether ceilings are inclusive
  and how empty ranges are represented. *Height*[~][node-height] follows
  *basin edges*[~][strong-edge], not inline trie nesting.

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
Directory digests include UTF-8 byte-sorted, length-framed basenames and
the corresponding child digests, so a rename changes directory identity.

Before choosing a shortcut layout, measure first-useful-result latency, fetched
bytes, request count, and update churn against ordinary trie traversal. Keep
content identity and consumer aggregation independent of allocation details.
