interface VectorNode_S0<
  MigrationsT extends { [index: number]: { Summary: unknown; Value: unknown } },
> extends BasinNode_S0<
    "sync.memoremix.com",
    ".vector-node/",
    { length: bigint; count: bigint; shift: U32; inlined: U32 },
    {
      [I in U32 & keyof MigrationsT]: [
        summary: MigrationsT[I]["Summary"],
        bitmap: U32,
        slots: Array<
          | MigrationsT[I]["Value"]
          | VectorNode_S0<MigrationsT>
          | BasinEdge_S0<VectorNode_S0<MigrationsT>>
        >,
      ];
    }
  > {}
