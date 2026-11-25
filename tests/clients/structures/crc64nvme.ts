/** CRC-64/NVME. Big-endian wire digest; little-endian reflected polynomial.
 * Byte hashing uses 32-bit halves so browsers need no BigInt work per byte. */
import { check } from "./core";
const polynomial = 0x9a6c9329ac4bc9b5n;
const high = new Uint32Array(256), low = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let hi = 0, lo = i;
  for (let bit = 0; bit < 8; bit++) {
    const odd = lo & 1;
    lo = (lo >>> 1) | (hi << 31);
    hi >>>= 1;
    if (odd) { hi ^= 0x9a6c9329; lo ^= 0xac4bc9b5; }
  }
  high[i] = hi; low[i] = lo;
}
export function hash(bytes: Uint8Array): Uint8Array {
  let hi = 0xffffffff, lo = 0xffffffff;
  for (const b of bytes) {
    const at = (lo ^ b) & 255;
    lo = (lo >>> 8) ^ (hi << 24) ^ low[at];
    hi = (hi >>> 8) ^ high[at];
  }
  const out = new Uint8Array(8), view = new DataView(out.buffer);
  view.setUint32(0, hi ^ 0xffffffff, false);
  view.setUint32(4, lo ^ 0xffffffff, false);
  return out;
}
function apply(columns: readonly bigint[], value: bigint): bigint {
  let out = 0n, bit = 0;
  while (value) {
    if (value & 1n) out ^= columns[bit];
    value >>= 1n; bit++;
  }
  return out;
}
let powers: bigint[][] | undefined;
function shifts(): bigint[][] {
  if (powers) return powers;
  const first = Array.from({ length: 64 }, (_, bit) => {
    let v = 1n << BigInt(bit);
    for (let i = 0; i < 8; i++) v = (v >> 1n) ^ (v & 1n ? polynomial : 0n);
    return v;
  });
  powers = [first];
  for (let i = 1; i < 64; i++) {
    const previous = powers[i - 1];
    powers.push(previous.map(v => apply(previous, v)));
  }
  return powers;
}
export function combine(left: Uint8Array, right: Uint8Array, rightLength: bigint): Uint8Array {
  check(left.length === 8 && right.length === 8, "invalid CRC64NVME length");
  check(rightLength >= 0n && rightLength <= 0xffffffffffffffffn, "invalid CRC64NVME range length");
  let crc = new DataView(left.buffer, left.byteOffset, 8).getBigUint64(0, false);
  let bit = 0, n = rightLength;
  const p = shifts();
  while (n) { if (n & 1n) crc = apply(p[bit], crc); n >>= 1n; bit++; }
  crc ^= new DataView(right.buffer, right.byteOffset, 8).getBigUint64(0, false);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, crc, false);
  return out;
}
