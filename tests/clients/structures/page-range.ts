/** Packed key-order bytes, distinct from Volume's fixed-page, zero-filled grid. */
import { check } from "./core";
import { Trie } from "./trie";
export async function readPageBytes<M extends { size: bigint }>(tree: Trie<[Uint8Array], M>, start: bigint, length: number) {
  check(start >= 0n && Number.isSafeInteger(length) && length >= 0 && length <= (tree.basin.options.maxBytes ?? 64 * 1024 * 1024), "invalid byte range");
  if (!length) return new Uint8Array();
  const end = start + BigInt(length), output = new Uint8Array(length);
  let at = 0n, written = 0;
  for await (const [, [bytes]] of tree.entries(new Uint8Array(), (_h, summary) => {
    check(typeof summary.size === "bigint" && summary.size >= 0n, "invalid page byte size");
    if (at + summary.size <= start) { at += summary.size; return false; }
    return at < end;
  })) {
    const a = start > at ? start : at, z = end < at + BigInt(bytes.length) ? end : at + BigInt(bytes.length);
    if (a < z) { output.set(bytes.subarray(Number(a - at), Number(z - at)), Number(a - start)); written += Number(z - a); }
    at += BigInt(bytes.length);
    if (at >= end) break;
  }
  return output.slice(0, written);
}
