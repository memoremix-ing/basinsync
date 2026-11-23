import { vectors } from "./vectors";

/** Object-key prefixes; a Rust test pins its constants to the same table. */
export const objectKeys = vectors<{
  timeline: string; basinEpilogue: string; analogue: string; kernelHeap: string;
  userHeap: string; userFlows: string; emptySentinel: string;
}>("object-keys");
