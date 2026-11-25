interface TrieNode_S0<
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

interface TrieGroup<ValueT> {
  keys: Array<Uint8Array>; // 255 maximum; suffixes after consumed prefix/branch bytes
  values: Array<ValueT>; // (one per key)
}

type TrieNest<
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

type SyncLink_M0<LazyT extends BasinNode_S0<string, string>> = {
  height: U32;
  version: U32;
  entropy: Uint8Array;
  revision: string;
  [Symbol.unscopables]?: LazyT;
};

type SyncSector_M1 = TrieNode_S0<{
  1: {
    Summary: {
      crc64nvme: Uint8Array; // eight-byte big-endian checksum over page bytes
      size: bigint; // sum of blob bytes, excluding keys and envelopes
    };

    Value: [data: Uint8Array];
  };
}>;
