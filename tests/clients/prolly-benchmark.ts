/** Client-only stored page indexes; no HTTP, S3 or Turso SQL in the timed workload. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Basin, MemoryStorage, type Storage, type Edge, type PendingEdge, utf8, concat } from "./structures/core";
import { Trie, composableConsumer } from "./structures/trie";
import { TrieView } from "./structures/trie-view";
import { sectors } from "./structures/volume";
import { ProllyPages } from "./structures/prolly";
import { readPageBytes } from "./structures/page-range";
import { encode as lex } from "./lexidecimal";
class Meter implements Storage {
  store = new MemoryStorage();
  metrics = { gets: 0, getBytes: 0, puts: 0, newObjects: 0, putBytes: 0 };
  reset() { this.metrics = { gets: 0, getBytes: 0, puts: 0, newObjects: 0, putBytes: 0 }; }
  async put(e: PendingEdge, b: Uint8Array, edges: readonly Edge[]) {
    this.metrics.puts++;
    const before = this.store.objects.size, r = await this.store.put(e, b, edges);
    if (this.store.objects.size > before) { this.metrics.newObjects++; this.metrics.putBytes += b.length; }
    return r;
  }
  async get(e: Edge) { const b = await this.store.get(e); this.metrics.gets++; this.metrics.getBytes += b.length; return b; }
}
const key = (n: number) => utf8(lex(BigInt(n)));
const count = Number(Bun.env.PROLLY_PAGES ?? 2048), rounds = Number(Bun.env.PROLLY_ROUNDS ?? 3);
const output: any[] = [];
for (const dataset of ["fixed", "variable"] as const) {
  const pages: [Uint8Array, Uint8Array][] = Array.from({ length: count }, (_, i) => [key(i * 2), new Uint8Array(dataset === "fixed" ? 16384 : (i * 7919) % 16385).fill(i % 251)]);
  const bytes = concat(pages.map(([, b]) => b));
  for (let round = 0; round < rounds; round++) {
    const variants = ["trie-1280", "trie-16", "prolly-8", "prolly-16", "prolly-32"];
    if (round % 2) variants.reverse();
    for (const variant of variants) {
      const storage = new Meter(), basin = new Basin(storage, { seed: new Uint8Array(32).fill(42) });
      let trie: Trie<[Uint8Array], typeof sectors.empty> | undefined, prolly: ProllyPages | undefined;
      const measure = async <T>(f: () => Promise<T>) => {
        basin.clearCache(); storage.reset(); const t = performance.now(), value = await f();
        return { value, ms: performance.now() - t, ...storage.metrics };
      };
      const build = await measure(async () => {
        if (variant.startsWith("prolly")) prolly = await ProllyPages.build(basin, pages, { target: Number(variant.split("-")[1]) });
        else {
          const consumer = variant === "trie-16" ? composableConsumer({ ...sectors, trieInlineCost: () => 80 }, { keyIndependent: true }) : sectors;
          trie = await Trie.build(basin, pages.map(([k, b]) => [k, [b]]), consumer);
        }
      });
      const lengths = [...storage.store.objects.values()].map(o => o.bytes.length).sort((a, b) => a - b);
      const point = await measure(async () => {
        for (const i of [0, Math.floor(count / 2), count - 1]) {
          basin.clearCache();
          const value = prolly ? await prolly.get(pages[i][0]) : (await trie!.get(pages[i][0]))?.[0];
          assert.deepEqual(value, pages[i][1]);
        }
      });
      const ranges = await measure(async () => {
        for (const [at, length] of [[0, 32], [Math.floor(bytes.length / 2), 32], [bytes.length - 32, 32], [Math.floor(bytes.length / 2), 131072]]) {
          basin.clearCache();
          const value = prolly ? await prolly.read(BigInt(at), length) : await readPageBytes(trie!, BigInt(at), length);
          assert.deepEqual(value, bytes.slice(at, at + length));
        }
      });
      const updates: Record<string, any> = {};
      for (const operation of ["overwrite", "append", "insert", "resize"] as const) {
        const i = Math.floor(count / 2);
        const edits: [Uint8Array, Uint8Array][] = operation === "append" ? Array.from({ length: 64 }, (_, j) => [key((count + j) * 2), new Uint8Array(16384).fill(99)])
          : [[operation === "insert" ? key(i * 2 + 1) : pages[i][0], new Uint8Array(operation === "resize" ? 17 : pages[i][1].length).fill(99)]];
        const edit = await measure(async () => {
          if (prolly) return (await prolly.update(edits)).root;
          let view = TrieView.from(trie!);
          for (const [k, v] of edits) view = view.set(k, [v]);
          return (await view.store()).root;
        });
        const model = new Map(pages.map(([k, b]) => [Buffer.from(k).toString("hex"), b]));
        for (const [k, b] of edits) model.set(Buffer.from(k).toString("hex"), b);
        const expected = concat([...model].sort(([a], [b]) => a < b ? -1 : 1).map(([, b]) => b));
        const verified = prolly ? await new ProllyPages(basin, edit.value).read(0n, expected.length) : await readPageBytes(new Trie(basin, edit.value, trie!.consumer), 0n, expected.length);
        assert.deepEqual(verified, expected);
        const { value, ...metrics } = edit; updates[operation] = metrics;
      }
      const { value: _b, ...buildMetrics } = build, { value: _p, ...pointMetrics } = point, { value: _r, ...rangeMetrics } = ranges;
      output.push({ dataset, round, variant, pages: count, bytes: bytes.length, build: buildMetrics, point: pointMetrics, ranges: rangeMetrics, updates,
        packing: { objects: lengths.length, min: lengths[0], median: lengths[Math.floor(lengths.length / 2)], max: lengths.at(-1) } });
      console.error(dataset, round, variant, 'range', rangeMetrics.ms.toFixed(1), 'overwrite', updates.overwrite.ms.toFixed(1));
    }
  }
}
console.log(JSON.stringify({ runtime: Bun.version, pages: count, rounds, results: output }, null, 2));
