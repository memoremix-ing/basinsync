// Wire-compatible with the sibling SDK; kept self-contained for this milestone.
const complement = (hex: string): string =>
  [...hex].map((d) => (15 - Number.parseInt(d, 16)).toString(16)).join("");

export function encode(value: bigint): string {
  const negative = value < 0n;
  const hex = (negative ? ~value : value).toString(16);
  const size = (hex.length - 1).toString(16);
  const width = (size.length - 1).toString(16);
  if (width.length !== 1) throw new Error("integer allocation too large");
  const body = `${width}${size}${hex}`;
  return negative ? `0y${complement(body)}` : `0z${body}`;
}

export function decode(wire: string): bigint {
  if (!/^0[yz][0-9a-f]{3,}$/.test(wire)) throw new Error("invalid Lexidecimal");
  const negative = wire[1] === "y";
  const body = negative ? complement(wire.slice(2)) : wire.slice(2);
  const start = 2 + Number.parseInt(body[0], 16);
  if (body.length <= start) throw new Error("missing value");
  if (BigInt(`0x${body.slice(1, start)}`) !== BigInt(body.length - start - 1))
    throw new Error("incorrect size");
  const magnitude = BigInt(`0x${body.slice(start)}`);
  const value = negative ? ~magnitude : magnitude;
  if (encode(value) !== wire) throw new Error("noncanonical Lexidecimal");
  return value;
}

export const key = (viewpoint: bigint): string => {
  if (viewpoint < 0n) throw new Error("negative viewpoint");
  return `epilogue/${encode(~viewpoint)}`;
};
