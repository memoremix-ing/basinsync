export type ProllyPolicy_S0 = {
  target: U32;
  min: U32;
  max: U32;
  maxBytes: U32;
  branchTarget: U32;
  branchMax: U32;
};

export type ProllySummary_S0 = {
  size: bigint; // concatenated page bytes; no keys, envelopes or sparse-grid gaps
  count: bigint;
  crc64nvme: Uint8Array;
};

export interface ProllyPages_S0 extends BasinNode_S0<
  "sync.memoremix.com",
  ".prolly-pages/",
  {
    depth: U32;
    keys: Bounds<Uint8Array>;
    closed: boolean; // boundary closes independently of EOF
    policy: ProllyPolicy_S0;
  },
  {
    0: [
      summary: ProllySummary_S0,
      leaf: { keys: Array<Uint8Array>; pages: Array<Uint8Array> } | null,
      children: Array<BasinEdge_S0<ProllyPages_S0, ProllyPages_S0[5], { 0: [ProllySummary_S0] }>> | null,
    ];
  }
> {}
