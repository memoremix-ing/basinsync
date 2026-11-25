export type U32 = number;

// null denotes no observations; nonempty bounds include both ends.
export type Bounds<T> = null | [floor: T, ceiling: T];

export type SCHEMA_0 = 0;

export type Footers = {
  [migration: number]: [summary: unknown, ...data: Array<unknown>];
};

export interface BasinNode_S0<
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

export type BasinQuery_S0 = {
  height: U32; // (for DAG invariants and basin ids)
  degree: U32; // shallow count of edges
  breadth: bigint; // approximate deep degree; shared descendants may contribute repeatedly
  rotations: Bounds<U32>; // deep aggregate from edges
  versions: Bounds<U32>; // deep aggregate from edges
  schemas: Bounds<U32>; // deep aggregate over edges
  migrations: Bounds<U32>; // deep aggregate over edges
};

export type BasinEdge_S0<
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
  kind: typeof Symbol.match,
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


export interface TrieNode_S0<
  MigrationsT extends {
    [migration: number]: { Summary: unknown; Value: unknown };
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
    keys: Bounds<Uint8Array>; // suffix bounds after ancestor bytes, before this node's prefix
    lengths: Bounds<U32>; // min/max lengths of those suffixes
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

export interface TrieGroup<ValueT> {
  keys: Array<Uint8Array>; // 255 maximum; suffixes after consumed prefix/branch bytes
  values: Array<ValueT>; // (one per key)
}

export type TrieNest<
  MigrationsT extends {
    [migration: number]: { Summary: unknown; Value: unknown };
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

interface SyncVolume_S0 extends BasinNode_S0<
  "sync.memoremix.com", ".sync-volume/", null,
  { 1: [summary: null, root: SyncDirectory_M0] }
> {}

type SyncDirectory_M0 = [
  folder: true,
  sha384: Uint8Array,
  inlined: U32,
  nesting: U32,
  contents: SyncDirectoryContents_M0 | BasinEdge_S0<SyncDirectoryContents_M0>,
];

type SyncDirectoryContents_M0 = TrieNode_S0<{
  0: { Summary: null; Value: SyncDirectory_M0 | SyncFile_M1 };
}>;

type SyncFile_M1 = [
  folder: false,
  crc64nvme: Uint8Array,
  edge: BasinEdge_S0<SyncBlock_M2>,
];

type SyncLink_M0<LazyT extends BasinNode_S0<string, string>> = {
  height: U32;
  version: U32;
  entropy: Uint8Array;
  revision: string;
  [Symbol.unscopables]?: LazyT;
};

interface SyncBlock_M2 extends BasinNode_S0<
  "sync.memoremix.com", ".sync-block/", { pageSize: U32 },
  {
    2: [
      summary: null,
      contents: [
        contentDefined: SyncSector_M1 | BasinEdge_S0<SyncSector_M1>,
        pageDefined: SyncSector_M1 | BasinEdge_S0<SyncSector_M1>,
      ],
      leading: Array<null | SyncPageLink_M0>,
      lagging: Array<null | SyncPageLink_M0>,
    ];
  }
> {}

type SyncPageLink_M0 = {
  prefix: Uint8Array; // absolute key prefix removed before traversing the target
  sha384: Uint8Array; // SHA-384 of the complete target basin-node EnvBuf
  link: SyncLink_M0<SyncSector_M1>;
};

export type SyncSector_M1 = TrieNode_S0<{
  1: {
    Summary: {
      crc64nvme: Uint8Array; // eight-byte big-endian checksum over page bytes
      size: bigint; // sum of blob bytes, excluding keys and envelopes
    };

    Value: [data: Uint8Array];
  };
}>;

export interface VectorNode_S0<
  MigrationsT extends { [migration: number]: { Summary: unknown; Value: unknown } },
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
export type VectorEdge_S0<
  MigrationsT extends { [migration: number]: { Summary: unknown; Value: unknown } },
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

export interface BTreeNode_S0<
  MigrationsT extends { [migration: number]: { Summary: unknown; Value: unknown } },
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

interface BPlusNode_S0<
  MigrationsT extends { [migration: number]: { Summary: unknown; Value: unknown } },
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
  MigrationsT extends { [migration: number]: { Summary: unknown; Value: unknown } },
> = BasinEdge_S0<BasinNode_S0<
  "sync.memoremix.com", ".bplus-node/", BPlusNode_S0<MigrationsT>[5],
  { [I in U32 & keyof MigrationsT]: [summary: MigrationsT[I]["Summary"]] }
>>;

type BPlusHint_S0<
  MigrationsT extends { [migration: number]: { Summary: unknown; Value: unknown } },
> = {
  keys: [Uint8Array, Uint8Array];
  link: SyncLink_M0<BPlusNode_S0<MigrationsT>>;
  sha384: Uint8Array;
};

