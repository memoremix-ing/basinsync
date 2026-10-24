export function encode(value: bigint): string {
  const negative = value < 0n;
  const hex = (negative ? ~value : value).toString(16);
  const digits = negative ? [...hex].map(d => (15 - Number.parseInt(d,16)).toString(16)).join("") : hex;
  return `0w${[...digits].reverse().join("")}${negative ? "y" : "z"}`;
}
export function decode(wire: string): bigint {
  if (!/^0w[0-9a-f]+[yz]$/.test(wire)) throw new Error("invalid Diffuse16");
  const negative = wire.endsWith("y");
  const hex = [...wire.slice(2, -1)].reverse();
  const magnitude = BigInt(`0x${hex.map(d => negative ? (15 - Number.parseInt(d,16)).toString(16) : d).join("")}`);
  const value = negative ? ~magnitude : magnitude;
  if (encode(value) !== wire) throw new Error("noncanonical Diffuse16");
  return value;
}
export function key(milestone: bigint): string {
  if (milestone < 1n) throw new Error("Milestone starts at one");
  const result = `timeline/${encode(milestone)}`;
  if (result.length > 1024) throw new Error("S3 key too long");
  return result;
}
export function fromKey(key: string): bigint {
  if (!key.startsWith("timeline/")) throw new Error("invalid Timeline prefix");
  const value = decode(key.slice(9));
  if (key !== `timeline/${encode(value)}` || value < 1n) throw new Error("invalid Milestone");
  return value;
}
