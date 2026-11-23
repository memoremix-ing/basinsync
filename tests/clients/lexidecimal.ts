import { objectKeys } from "./object-keys";
// Independent client implementation used to cross-check the Rust codec.
const complement = (hex: string): string =>
  [...hex].map((d) => (15 - Number.parseInt(d, 16)).toString(16)).join("");

export function sizePrefix(size: number, negative = false): string {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid size");
  const hex = size.toString(16);
  let width = 1, magnitude = -1;
  while (width < hex.length) { width *= 2; magnitude++; }
  if (magnitude > 3) throw new Error("size allocation too large");
  const power = width === 1 ? "" : (negative ? "ZYXW" : "wxyz")[magnitude];
  const digits = [...hex.padStart(width, "0")].map(d => String.fromCharCode(negative ? 118 - Number.parseInt(d,16) : 103 + Number.parseInt(d,16))).join("");
  return power + digits;
}

export function encode(value: bigint): string {
  const negative = value < 0n;
  const hex = (negative ? ~value : value).toString(16);
  return `${negative ? "0y" : "0z"}${sizePrefix(hex.length - 1,negative)}${negative ? complement(hex) : hex}`;
}

export function decode(wire: string): bigint {
  if (!/^0[yz]/.test(wire)) throw new Error("invalid Lexidecimal sign");
  const negative = wire[1] === "y", body = wire.slice(2);
  const magnitude = (negative ? "ZYXW" : "wxyz").indexOf(body[0] ?? "!");
  const start = magnitude < 0 ? 0 : 1, width = magnitude < 0 ? 1 : 1 << (1 + magnitude);
  const size = body.slice(start,start + width), hex = body.slice(start + width);
  if (size.length !== width || !/^[g-v]+$/.test(size) || !/^[0-9a-f]+$/.test(hex)) throw new Error("invalid Lexidecimal body");
  const digits = [...size].map(d => (negative ? 118-d.charCodeAt(0) : d.charCodeAt(0)-103).toString(16)).join("");
  if (BigInt(`0x${digits}`) !== BigInt(hex.length - 1)) throw new Error("incorrect size");
  const magnitudeValue = BigInt(`0x${negative ? complement(hex) : hex}`);
  const value = negative ? ~magnitudeValue : magnitudeValue;
  if (encode(value) !== wire) throw new Error("noncanonical Lexidecimal");
  return value;
}

export const key = (viewpoint: bigint): string => {
  if (viewpoint < 0n) throw new Error("negative viewpoint");
  return `${objectKeys.basinEpilogue}${encode(~viewpoint)}`;
};
