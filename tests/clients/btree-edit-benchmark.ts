/** Client CPU only; storage adapter is memory, never S3. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Basin, MemoryStorage } from "./structures/core";
import { BTree, BTreeMap } from "./structures/btree";
import { plain } from "./structures/trie";
const baselinePath = Bun.env.BTREE_BASELINE;
if (!baselinePath)
  throw Error("BTREE_BASELINE must name the archived pre-change module");
const Original = (await import(baselinePath)).BTree;
const AwaitOnly = (await import(Bun.env.BTREE_AWAIT_ONLY!)).BTree;
const seed = new Uint8Array(32).fill(42),
  n = 20000;
const keys = Array.from(
  { length: n },
  (_, i) =>
    new Uint8Array([i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]),
);
const rows = keys.map((k, i) => [k, i] as [Uint8Array, number]);
const results: any[] = [];
for (let trial = 0; trial < 5; trial++) {
  for (const variant of trial % 2
    ? ["new", "await-only", "original"]
    : ["original", "await-only", "new"]) {
    const C =
      variant === "new"
        ? BTree
        : variant === "await-only"
          ? AwaitOnly
          : Original;
    const b = new Basin(new MemoryStorage(), { seed });
    let at = performance.now();
    const t = await C.build(b, rows, plain);
    const buildMs = performance.now() - at;
    // Warm all relevant nodes and lookup plans before timing reads.
    for (let i = 0; i < 2048; i++)
      assert.equal(await t.get(keys[(i * 7919) % n]), (i * 7919) % n);
    at = performance.now();
    let sum = 0;
    for (let i = 0; i < 100000; i++)
      sum += (await t.get(keys[(i * 7919) % n])) as number;
    const asyncMs = performance.now() - at;
    assert(sum > 0);
    let readyMs: number | undefined;
    if (variant === "new") {
      at = performance.now();
      sum = 0;
      for (let i = 0; i < 100000; i++) {
        const v = t.getOrDefer(keys[(i * 7919) % n]);
        assert.notEqual(typeof v, "function");
        sum += v as number;
      }
      readyMs = performance.now() - at;
      assert(sum > 0);
    }
    results.push({ trial, variant, buildMs, asyncMs, readyMs });
  }
}
let logical = BTreeMap.from(rows);
const held = logical;
let at = performance.now();
for (let i = 0; i < 10000; i++) logical = logical.set(keys[(i * 7919) % n], -i);
const editsMs = performance.now() - at;
logical.validate();
assert.equal(held.get(keys[7919]), 7919);
at = performance.now();
let copied = new Map(rows.map(([k, v]) => [Array.from(k).join(","), v]));
for (let i = 0; i < 10000; i++) {
  const next = new Map(copied);
  next.set(Array.from(keys[(i * 7919) % n]).join(","), -i);
  copied = next;
}
const wholeMapMs = performance.now() - at;
const result = {
  runtime: Bun.version,
  n,
  method:
    "5 alternating trials; synchronous null summaries; memory storage; 100k warm reads; 10k persistent replacements; export includes crypto, serialization and memory puts",
  results,
  editsMs,
  wholeMapMs,
};
writeFileSync(
  Bun.env.BTREE_BENCH_OUT ?? ".local/btree-edit.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
