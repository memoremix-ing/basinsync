/** Match cache misses when comparing retained continuations with root restarts. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  Basin,
  MemoryStorage,
  type Edge,
  type Storage,
} from "./structures/core";
import { Trie, plain } from "./structures/trie";
import { Vector } from "./structures/vector";
import { BTree } from "./structures/btree";
import { resolveOperation, type Operation } from "./structures/operation";
const seed = new Uint8Array(32).fill(42),
  n = 20000;
const keys = Array.from(
  { length: n },
  (_, i) => new Uint8Array([i >>> 16, (i >>> 8) & 255, i & 255]),
);
const storage = new MemoryStorage(),
  b = new Basin(storage, { seed });
const sources = [
  {
    name: "trie",
    tree: await Trie.build(
      b,
      keys.map((k, i) => [k, i]),
      plain,
    ),
    open: (b: Basin, e: Edge) => new Trie(b, e, plain),
  },
  {
    name: "vector",
    tree: await Vector.build(
      b,
      keys.map((_, i) => i),
      plain,
    ),
    open: (b: Basin, e: Edge) => new Vector(b, e, plain),
  },
  {
    name: "btree",
    tree: await BTree.build(
      b,
      keys.map((k, i) => [k, i]),
      plain,
    ),
    open: (b: Basin, e: Edge) => new BTree(b, e, plain),
  },
];
async function restart(read: () => Operation<unknown>) {
  for (;;) {
    const op = read();
    if (typeof op !== "function") return op;
    const g = op();
    const step = g.next();
    if (step.done) return step.value;
    await step.value;
    g.return(undefined);
  }
}
const samples: any[] = [];
for (let trial = 0; trial < 3; trial++)
  for (const latencyMs of [0, 2])
    for (const cache of ["cold", "root-ready"])
      for (const s of sources)
        for (const mode of trial % 2
          ? ["restart", "resume"]
          : ["resume", "restart"]) {
          let gets = 0,
            bytes = 0,
            elapsed = 0;
          const lookups = latencyMs ? 32 : 1024;
          for (let i = 0; i < lookups; i++) {
            const adapter: Storage = {
              put: storage.put.bind(storage),
              get: async (e) => {
                gets++;
                const d = await storage.get(e);
                bytes += d.length;
                if (latencyMs)
                  await new Promise((r) => setTimeout(r, latencyMs));
                return d;
              },
            };
            const basin = new Basin(adapter, { seed }),
              reader = s.open(basin, s.tree.root),
              which = (i * 7919) % n;
            if (cache === "root-ready") {
              const savedGets = gets,
                savedBytes = bytes;
              await basin.load(s.tree.root);
              gets = savedGets;
              bytes = savedBytes;
            }
            const read = () =>
              s.name === "vector"
                ? (reader as Vector<number>).getOrDefer(BigInt(which))
                : (reader as Trie<number> | BTree<number>).getOrDefer(
                    keys[which],
                  );
            const at = performance.now(),
              value =
                mode === "resume"
                  ? await resolveOperation(read())
                  : await restart(read);
            elapsed += performance.now() - at;
            assert.equal(value, which);
          }
          samples.push({
            trial,
            lookups,
            structure: s.name,
            latencyMs,
            cache,
            mode,
            gets,
            bytes,
            ms: elapsed,
          });
        }
writeFileSync(
  Bun.env.CONTINUATION_OUT ?? ".local/continuation.json",
  JSON.stringify(
    {
      runtime: Bun.version,
      n,
      lookups: "1024 at zero delay, 32 at 2ms",
      method:
        "new cache per key; root preparation excluded; restart discards read-only continuation after each awaited load; identical keys and storage",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log("continuation measurements complete");
