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
