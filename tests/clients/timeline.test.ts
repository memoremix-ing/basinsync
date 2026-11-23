import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { key, fromKey } from "./timeline";
import { encode } from "./lexidecimal";
import { vectors } from "./vectors";
import { objectKeys } from "./object-keys";

const shared = vectors<{keys:[string,string][];invalidKeys:string[]}>("timeline");

test("shared key vectors and rejection", () => {
  for (const [m, expected] of shared.keys) { expect(key(BigInt(m))).toBe(expected); expect(fromKey(expected)).toBe(BigInt(m)); }
  for (const bad of [...shared.invalidKeys, `${objectKeys.timeline}${encode(~(1n << 4096n))}`]) expect(() => fromKey(bad)).toThrow();
  for (const m of [0n, -1n, 1n << 4096n]) expect(() => key(m)).toThrow();
});

test("keys round-trip and list newest Milestones first", () => {
  const milestones = new Set<bigint>([1n]);
  for (const bits of [4n, 8n, 64n, 68n, 256n, 1024n]) {
    const n = 1n << bits;
    for (const m of [n - 1n, n, n + 1n]) milestones.add(m);
  }
  for (let i = 0; i < 256; i++) milestones.add(BigInt(`0x${randomBytes(200).toString("hex")}`) + 1n);
  const ordered = [...milestones].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  for (const m of ordered) expect(fromKey(key(m))).toBe(m);
  expect(ordered.map(key).sort()).toEqual(ordered.map(key).reverse());
});
