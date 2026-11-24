interface VectorNode_S0<
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
type VectorEdge_S0<
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
