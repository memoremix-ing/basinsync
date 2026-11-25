/** Browser entry: logical client CPU, no storage, aggregation or crypto. */
import { TrieMap } from "./structures/logical-trie";
import { VectorMap } from "./structures/logical-vector";
import { BTreeMap } from "./structures/logical-btree";
const n = 20000,
  keys = Array.from(
    { length: n },
    (_, i) => new Uint8Array([i >>> 16, (i >>> 8) & 255, i & 255]),
  );
const rows = keys.map((k, i) => [k, i] as [Uint8Array, number]);
const samples: any[] = [];
for (let trial = 0; trial < 5; trial++)
  for (const kind of trial % 2
    ? ["btree", "vector", "trie"]
    : ["trie", "vector", "btree"]) {
    let at = performance.now();
    let tree: any =
      kind === "trie"
        ? TrieMap.from(rows)
        : kind === "btree"
          ? BTreeMap.from(rows)
          : VectorMap.from(
              BigInt(n),
              rows.map(([, v]) => [BigInt(v), v]),
              5,
            );
    const buildMs = performance.now() - at;
    const held = tree;
    at = performance.now();
    for (let i = 0; i < 10000; i++)
      tree = tree.set(
        kind === "vector" ? BigInt((i * 7919) % n) : keys[(i * 7919) % n],
        -i,
      );
    const editsMs = performance.now() - at;
    if (held.get(kind === "vector" ? 7919n : keys[7919]) !== 7919)
      throw Error("snapshot changed");
    at = performance.now();
    let sum = 0;
    for (let i = 0; i < 100000; i++)
      sum += tree.get(
        kind === "vector" ? BigInt((i * 7919) % n) : keys[(i * 7919) % n],
      );
    const readsMs = performance.now() - at;
    if (!Number.isFinite(sum)) throw Error("invalid result");
    samples.push({ trial, kind, buildMs, editsMs, readsMs });
  }
(globalThis as any).benchmark = {
  userAgent: navigator.userAgent,
  n,
  method:
    "5 alternating browser trials; keys precomputed bytes, vector indexes converted to bigint inside loops; 10k persistent replacements, 100k reads; excludes storage/aggregation/crypto/export",
  samples,
};
console.log(
  JSON.stringify({ ...(globalThis as any).benchmark, samples: undefined }),
);
for (const sample of samples) console.log(JSON.stringify(sample));
