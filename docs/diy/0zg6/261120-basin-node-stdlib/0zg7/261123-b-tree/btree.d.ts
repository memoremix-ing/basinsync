interface BTreeNode_S0<
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
