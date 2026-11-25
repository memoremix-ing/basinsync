/** LSB-first occupancy; keep the common <=32-slot case in one host word. */
import { check } from "./core";
export type Bitmap = number | readonly number[];
export function vectorBits(bits = 5): number {
  check(
    Number.isInteger(bits) && bits >= 1 && bits <= 8,
    "vector bits must be 1..8",
  );
  return bits;
}
export function emptyBitmap(bits: number): Bitmap {
  return bits <= 5 ? 0 : new Array(1 << (bits - 5)).fill(0);
}
export function popcount(x: number) {
  x >>>= 0;
  let n = 0;
  while (x) {
    x = (x & (x - 1)) >>> 0;
    n++;
  }
  return n;
}
export function has(bitmap: Bitmap, slot: number) {
  return (
    (((typeof bitmap === "number" ? bitmap : bitmap[slot >>> 5]) >>>
      (slot & 31)) &
      1) !==
    0
  );
}
export function rank(bitmap: Bitmap, slot: number) {
  if (typeof bitmap === "number") return popcount(bitmap & (2 ** slot - 1));
  let n = 0;
  for (let w = 0; w < slot >>> 5; w++) n += popcount(bitmap[w]);
  return n + popcount(bitmap[slot >>> 5] & (2 ** (slot & 31) - 1));
}
export function changeBit(
  bitmap: Bitmap,
  slot: number,
  present: boolean,
): Bitmap {
  const bit = 1 << (slot & 31),
    word = typeof bitmap === "number" ? bitmap : bitmap[slot >>> 5];
  const next = (present ? word | bit : word & ~bit) >>> 0;
  if (typeof bitmap === "number") return next;
  const copy = bitmap.slice();
  copy[slot >>> 5] = next;
  return copy;
}
export function bitmapBytes(bitmap: Bitmap, bits: number): Uint8Array {
  return Uint8Array.from(
    { length: Math.max(1, (1 << bits) / 8) },
    (_, i) =>
      ((typeof bitmap === "number" ? bitmap : bitmap[i >>> 2]) >>>
        ((i & 3) * 8)) &
      255,
  );
}
export function readBitmap(bytes: Uint8Array, bits: number): Bitmap {
  check(
    bytes instanceof Uint8Array &&
      bytes.length === Math.max(1, (1 << bits) / 8),
    "invalid vector bitmap length",
  );
  check(
    bits >= 3 || bytes[0] >>> (1 << bits) === 0,
    "invalid vector bitmap bits",
  );
  const words = new Array(Math.max(1, 1 << Math.max(0, bits - 5))).fill(0);
  for (let i = 0; i < bytes.length; i++)
    words[i >>> 2] = (words[i >>> 2] | (bytes[i] << ((i & 3) * 8))) >>> 0;
  return bits <= 5 ? words[0] : words;
}
export function bitmapCount(bitmap: Bitmap): number {
  return typeof bitmap === "number"
    ? popcount(bitmap)
    : bitmap.reduce((n, w) => n + popcount(w), 0);
}
