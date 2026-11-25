export type ProllyFilePolicy_S0 = {
  min: U32;
  target: U32;
  max: U32;
  branchTarget: U32;
  branchMax: U32;
  runAnchors: boolean;
};

export type ProllyFileSummary_S0 = {
  size: bigint;
  crc64nvme: Uint8Array;
  content: Uint8Array; // domain-separated SHA-384 of bytes or ordered child content IDs/sizes
};

export interface ProllyFile_S0 extends BasinNode_S0<
  "sync.memoremix.com",
  ".prolly-file/",
  { depth: U32; closed: boolean; policy: ProllyFilePolicy_S0 },
  {
    0: [
      summary: ProllyFileSummary_S0,
      bytes: Uint8Array | null,
      children: Array<BasinEdge_S0<ProllyFile_S0, ProllyFile_S0[5], { 0: [ProllyFileSummary_S0] }>> | null,
    ];
  }
> {}
