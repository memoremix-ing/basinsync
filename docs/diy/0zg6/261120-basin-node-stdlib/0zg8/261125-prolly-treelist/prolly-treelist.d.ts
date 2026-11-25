export type ProllyTreelistPolicy_S0 = {
  boundary: "low" | "mixed";
  min: U32;
  target: U32;
  max: U32;
  branchTarget: U32;
  branchMax: U32;
  runAnchors: boolean;
};

export type ProllyTreelistSummary_S0 = {
  size: bigint;
  uniform: U32 | null; // repeated byte, 0..255, otherwise null
  crc64nvme: Uint8Array;
  content: Uint8Array; // domain-separated SHA-384 of bytes or ordered child content IDs/sizes
};

export interface ProllyTreelist_S0 extends BasinNode_S0<
  "sync.memoremix.com",
  ".prolly-treelist/",
  { depth: U32; closed: boolean; policy: ProllyTreelistPolicy_S0 },
  {
    0: [
      summary: ProllyTreelistSummary_S0,
      bytes: Uint8Array | null,
      children: Array<BasinEdge_S0<ProllyTreelist_S0, ProllyTreelist_S0[5], { 0: [ProllyTreelistSummary_S0] }>> | null,
    ];
  }
> {}
