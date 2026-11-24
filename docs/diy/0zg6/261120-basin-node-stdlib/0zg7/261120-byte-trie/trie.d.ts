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

type SyncDevice_M0 = TrieNode_S0<{
  0: { Summary: null; Value: [edge: BasinEdge_S0<SyncBlock_M0>] };
}>;

interface SyncVolume_S0 extends BasinNode_S0<
  "sync.memoremix.com", ".sync-volume/", null,
  { 0: [summary: null, device: SyncDevice_M0 | BasinEdge_S0<SyncDevice_M0>,
    root: SyncDirectory_M0 | SyncDirectoryEdge_M0] }
> {}

interface SyncDirectory_M0 extends BasinNode_S0<
  "sync.memoremix.com", ".sync-directory/",
  { sha384: Uint8Array; inlined: U32; nesting: U32 },
  { 0: [summary: null, contents: TrieNode_S0<{
    0: { Summary: null; Value: SyncDirectoryEntry_M0 };
  }>] }
> {}

type SyncDirectoryEntry_M0 = SyncFile_M0 | [
  folder: true, sha384: Uint8Array, directory: SyncDirectory_M0 | SyncDirectoryEdge_M0
];
type SyncDirectoryEdge_M0 = BasinEdge_S0<BasinNode_S0<
  "sync.memoremix.com", ".sync-directory/", SyncDirectory_M0[5], {0:[summary:null]}
>>;

type SyncFile_M0 = [
  folder: false,
  brombergSL2: Uint8Array, // (cache of linked block's own digest)
  link: SyncLink_M0<SyncBlock_M0>,
];

type SyncLink_M0<LazyT extends BasinNode_S0<string, string>> = {
  height: U32;
  version: U32;
  entropy: Uint8Array;
  revision: string; // node allocation revision

  [Symbol.unscopables]?: LazyT;
};

interface SyncBlock_M0
  extends BasinNode_S0<
    "sync.memoremix.com",
    ".sync-block/",
    null,
    {
      0: [
        summary: null,
        // (lexidecmal trie keys encoded from sparse page numbers)
        pages: SyncSector_M0 | BasinEdge_S0<SyncSector_M0>,
        leaves: SyncLeaves_M0 | BasinEdge_S0<SyncLeaves_M0>, // dense, page-sorted; seven bits per level
        leading: Array<null | SyncLink_M0<SyncLeaves_M0>>, // basin height indexes; exclude vector root
        lagging: Array<null | SyncLink_M0<SyncLeaves_M0>>,
      ];
    }
  > {}

type SyncLeaves_M0 = VectorNode_S0<{
  0: {
    Summary: { pages: Bounds<bigint> };
    Value: [page: bigint, span: U32, link: SyncLink_M0<SyncSector_M0>];
  };
}>;

type SyncSector_M0 = TrieNode_S0<{
  0: {
    Summary: {
      brombergSL2: Uint8Array; // homomorphic checksum over the blobs in the page range
    };

    Value: [data: Uint8Array];
  };
}>;
