import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decode, encode, key, sizePrefix } from "./lexidecimal";
import { vectors } from "./vectors";

const shared = vectors<{canonical:[string,string][];invalid:string[];sizePrefixes:[number,string,string][]}>("lexidecimal");

test("shared vectors", () => {
  for (const [n, wire] of shared.canonical) { expect(encode(BigInt(n))).toBe(wire); expect(decode(wire)).toBe(BigInt(n)); }
  for (const bad of shared.invalid) expect(() => decode(bad)).toThrow();
  for (const [size, positive, negative] of shared.sizePrefixes) { expect(sizePrefix(size)).toBe(positive); expect(sizePrefix(size, true)).toBe(negative); }
});

test("encodings round-trip and sort like their values; viewpoint keys sort in reverse", () => {
  const values = new Set<bigint>([0n]);
  for (const bits of [4n,8n,64n,68n,256n,1024n,4096n,262144n]) {
    const n = 1n << bits;
    for (const x of [n-1n,n,n+1n]) { values.add(x); values.add(-x); }
  }
  for (let i=0; i<256; i++) values.add(BigInt(`0x${randomBytes(256).toString("hex")}`) * (i%2 ? 1n : -1n));
  const ordered = [...values].sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  expect(ordered.map(encode).sort()).toEqual(ordered.map(encode));
  for (const n of ordered) expect(decode(encode(n))).toBe(n);
  const viewpoints = ordered.filter(n => n >= 0n);
  expect(viewpoints.map(key).sort()).toEqual(viewpoints.map(key).reverse());
});
