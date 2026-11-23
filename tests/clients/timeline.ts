import { decode, encode } from "./lexidecimal";
import { objectKeys } from "./object-keys";

export function key(milestone: bigint): string {
  if (milestone < 1n) throw new Error("Milestone starts at one");
  const result = `${objectKeys.timeline}${encode(~milestone)}`;
  if (result.length > 1024) throw new Error("S3 key too long");
  return result;
}

export function fromKey(key: string): bigint {
  if (!key.startsWith(objectKeys.timeline)) throw new Error("invalid Timeline prefix");
  const milestone = ~decode(key.slice(objectKeys.timeline.length));
  if (key !== `${objectKeys.timeline}${encode(~milestone)}` || milestone < 1n)
    throw new Error("invalid Milestone");
  if (key.length > 1024) throw new Error("S3 key too long");
  return milestone;
}
