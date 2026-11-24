import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  Basin,
  MemoryStorage,
  type Edge,
  type PendingEdge,
} from "./structures/core";
import { Trie, plain } from "./structures/trie";
import { TrieView } from "./structures/trie-view";
class Trace extends MemoryStorage {
  puts = 0;
  override async put(
    e: PendingEdge,
    b: Uint8Array,
    edges: readonly Edge[] = [],
  ) {
    this.puts++;
    return super.put(e, b, edges);
  }
}
const seed = new Uint8Array(32).fill(42),
  s = new MemoryStorage(),
  b = new Basin(s, { seed });
const source = await Trie.build(
    b,
    Array.from(
      { length: 100000 },
      (_, i) => [i.toString(16).padStart(8, "0"), i] as [string, number],
    ),
    plain,
  ),
  archive = [...s.objects.values()];
const samples: any[] = [];
let digest: Uint8Array | undefined;
for (let trial = 0; trial < 5; trial++)
  for (const selective of trial % 2 ? [true, false] : [false, true]) {
    const store = new Trace();
    for (const v of archive) await store.restore(v.edge, v.bytes, v.edges);
    const basin = new Basin(store, { seed }),
      c = selective ? plain : { ...plain };
    const start = performance.now(),
      out = await TrieView.from(new Trie(basin, source.root, c))
        .set("0000ffff", -1)
        .store();
    const ms = performance.now() - start;
    if (digest) assert.deepEqual(out.root[6].sha384, digest);
    else digest = out.root[6].sha384;
    samples.push({
      trial,
      selective,
      ms,
      gets: store.reads,
      puts: store.puts,
      newObjects: store.objects.size - archive.length,
    });
  }
mkdirSync(".local/selective", { recursive: true });
writeFileSync(
  ".local/selective/runs.json",
  JSON.stringify(
    {
      runtime: Bun.version,
      scope:
        "cold 100,000-entry trie, one replacement; identical canonical outputs; in-memory storage",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log(samples);
