type U32 = number;

// Proposed: null denotes no observations; nonempty bounds include both ends.
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
  height: U32; // (for DAG inaviants and basin ids)
  degree: U32; // shallow count of edges
  breadth: bigint; // deep aggregate degree
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
      length: U32; // shallow byte-length of basin-node in object storage
      weight: bigint; // deep approximate byte-length of basin-node graph in object storage (may include duplicates)
      sha384: Uint8Array; // digest of basin-node in object storage
      entropy: Uint8Array; // 256-bits of confidential key material for HKDFing a token, secret, and nonce
      rotation: U32; // KMS-specific hint of the key for the root that introduced the referenced node

      [Symbol.unscopables]?: LazyT; // lazy-loaded (never embedded in serializations)
    };
  }[U32 & keyof FootersT],
];

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
    keys: Bounds<Uint8Array>;
    reversals: Bounds<Uint8Array>; // min/max reverse-key
    lengths: Bounds<U32>; // min/max key-lengths
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
  keys: Array<Uint8Array>; // 63 maximum; suffixes after consumed prefix/branch bytes
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
