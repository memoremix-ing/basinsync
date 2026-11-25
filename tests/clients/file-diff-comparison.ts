/** Matched byte-file edits: fixed/CDC chunking, trie/treelist routing, local refinement. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Basin, MemoryStorage, concat, utf8, type Storage, type Edge, type PendingEdge } from "./structures/core";
import { TrieBytes } from "./structures/trie-bytes";
import { ProllyTreelist, chunkBytes } from "./structures/prolly-treelist";
import { diffBytes, type ByteSequence } from "./structures/byte-diff";
class Meter implements Storage {
  store = new MemoryStorage(); stats = { gets: 0, bytes: 0, puts: 0, newBytes: 0, newObjects: 0, peak: 0 };
  active = 0; waiting: (() => void)[] = []; wire = 0; latency = 0; rate = Infinity;
  reset() { this.stats = { gets: 0, bytes: 0, puts: 0, newBytes: 0, newObjects: 0, peak: 0 }; this.wire = 0; }
  async get(e: Edge) {
    if (this.active >= 4) await new Promise<void>(r => this.waiting.push(r)); else this.active++;
    try {
      this.stats.peak = Math.max(this.stats.peak, this.active);
      const b = await this.store.get(e); this.stats.gets++; this.stats.bytes += b.length;
      if (this.latency) await Bun.sleep(this.latency);
      if (this.rate !== Infinity) { this.wire = Math.max(this.wire, performance.now()) + b.length / this.rate * 1000; await Bun.sleep(Math.max(0, this.wire - performance.now())); }
      return b;
    } finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  async put(e: PendingEdge, b: Uint8Array, edges: readonly Edge[]) { this.stats.puts++; const n = this.store.objects.size, revision = await this.store.put(e, b, edges); if (this.store.objects.size > n) { this.stats.newBytes += b.length; this.stats.newObjects++; } return revision; }
}
const size = Number(Bun.env.DIFF_COMPARE_BYTES ?? 4 * 1024 * 1024), rounds = Number(Bun.env.DIFF_COMPARE_ROUNDS ?? 3), link = Bun.env.DIFF_COMPARE_LINK === "1";
function random(n: number, x = 0x13579bdf) { return Uint8Array.from({ length: n }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 24; }); }
function records(n: number) { const chunks: Uint8Array[] = []; let length = 0; for (let i = 0; length < n; i++) { const b = utf8(JSON.stringify({ id: i, path: `/home/project/${i % 197}/item-${i}.txt`, enabled: !!(i % 3), value: `record ${i} with repeated field names and different values` }) + "\n"); chunks.push(b); length += b.length; } return concat(chunks).slice(0, n); }
const layouts = Bun.env.DIFF_COMPARE_LAYOUTS?.split(",") ?? (link ? ["trie-fixed-default", "trie-fixed-tight", "trie-cdc-tight", "treelist-uniform"] : ["trie-fixed-default", "trie-fixed-tight", "trie-cdc-tight", "treelist-fixed", "treelist-gear", "treelist-mixed", "treelist-runs", "treelist-uniform"]);
const datasets = (Bun.env.DIFF_COMPARE_DATASETS?.split(",") ?? (link ? ["random", "records", "zeros"] : ["random", "records", "page-runs", "zeros"]));
const results: any[] = [];
for (const dataset of datasets) {
  const original = dataset === "random" ? random(size) : dataset === "records" ? records(size) : Uint8Array.from({ length: size }, (_, i) => dataset === "zeros" ? 0 : Math.floor(i / 16384) % 251);
  for (let round = 0; round < rounds; round++) for (const layout of round % 2 ? [...layouts].reverse() : layouts) {
    const meter = new Meter(), basin = new Basin(meter, { seed: new Uint8Array(32).fill(42) });
    const measure = async <T>(f: () => Promise<T>, cold = true) => { if (cold) basin.clearCache(); meter.reset(); const start = performance.now(), value = await f(); return { value, ms: performance.now() - start, ...meter.stats }; };
    const options = layout === "treelist-fixed" ? { min: 16384, target: 16384, max: 16384, runAnchors: false } : { runAnchors: layout !== "treelist-gear" && layout !== "treelist-mixed", boundary: layout === "treelist-gear" ? "low" as const : "mixed" as const };
    const build = await measure<TrieBytes | ProllyTreelist>(() => layout === "trie-cdc-tight" ? TrieBytes.chunks(basin, chunkBytes([original]), true) : layout.startsWith("trie-") ? TrieBytes.build(basin, original, layout.endsWith("tight")) : ProllyTreelist.build(basin, [original], options));
    const before = build.value;
    const sequence = (v: TrieBytes | ProllyTreelist): ByteSequence => v instanceof ProllyTreelist ? v.sequence(layout === "treelist-uniform") : v.sequence();
    const changes = Bun.env.DIFF_COMPARE_CHANGES?.split(",") ?? (link ? ["insert", "multi"] : ["same", "overwrite", "insert", "delete", "append", "scatter", "multi", "move", "replace"]);
    const samples = Number(Bun.env.DIFF_COMPARE_SAMPLES ?? 1);
    for (const { change, sample } of changes.flatMap(change => Array.from({ length: samples }, (_, sample) => ({ change, sample })))) {
      const mid = samples === 1 ? Math.floor(size / 2) + 37 : Math.floor(size * (sample + .37) / samples);
      let expected: Uint8Array, operations: [number, number, Uint8Array][];
      if (change === "same") operations = [];
      else if (change === "scatter" || change === "multi") operations = Array.from({ length: 8 }, (_, i) => { const at = change === "scatter" ? mid + i * 997 : Math.floor(size * (i + 1) / 10) + 37; return [at, 1, new Uint8Array([original[at] ^ 255])]; });
      else if (change === "move") { const at = Math.floor(size / 4), to = Math.floor(size * 3 / 4); operations = [[to, 0, original.slice(at, at + 65536)], [at, 65536, new Uint8Array()]]; }
      else operations = [[change === "append" ? size : mid, change === "delete-large" ? 131072 : change === "delete" ? 97 : change === "overwrite" ? 1 : change === "replace" ? 65536 : 0, (change === "delete" || change === "delete-large") ? new Uint8Array() : change === "append" ? random(16384) : change === "replace" ? random(65536, 89123) : change === "insert-large" ? random(131072, 12987) : change === "insert" ? random(97, 12987) : new Uint8Array([original[mid] ^ 255])]];
      operations.sort(([a], [b]) => b - a); expected = original;
      for (const [at, remove, add] of operations) expected = concat([expected.slice(0, at), add, expected.slice(at + remove)]);
      const update = await measure(async () => {
        if (layout === "trie-cdc-tight") return operations.length ? TrieBytes.chunks(basin, chunkBytes([expected]), true) : before;
        let next = before; for (const [at, remove, add] of operations) next = await next.splice(BigInt(at), BigInt(remove), add); return next;
      });
      const after = update.value;
      if (link) { meter.latency = 25; meter.rate = 20 * 1024 * 1024; }
      const diff = await measure(() => diffBytes(sequence(before), sequence(after)));
      const patch = await measure(async () => {
        const chunks: Uint8Array[] = []; let cursor = 0, newCursor = 0;
        for (const e of diff.value) { assert(e.before.start >= BigInt(cursor)); assert.equal(e.after.start - BigInt(newCursor), e.before.start - BigInt(cursor)); chunks.push(original.slice(cursor, Number(e.before.start)), await after.read(e.after.start, Number(e.after.length))); cursor = Number(e.before.start + e.before.length); newCursor = Number(e.after.start + e.after.length); }
        return concat([...chunks, original.slice(cursor)]);
      }, false);
      assert.deepEqual(patch.value, expected);
      meter.latency = 0; meter.rate = Infinity;
      const coarse = change === "scatter" ? await measure(() => diffBytes(sequence(before), sequence(after), 65536, 0)) : null;
      const omit = <T extends { value: unknown }>(x: T) => { const { value, ...m } = x; return m; };
      const row = { dataset, round, layout, change, sample, offset: mid, size, updateMode: layout === "trie-cdc-tight" ? "full-rechunk-build" : layout === "trie-fixed-tight" ? "weighted-export-fallback" : "incremental", build: omit(build), update: omit(update), diff: { ...omit(diff), edits: diff.value.length, replacementBytes: Number(diff.value.reduce((n, e) => n + e.after.length, 0n)) }, patch: omit(patch), coarse: coarse ? { ...omit(coarse), edits: coarse.value.length, replacementBytes: Number(coarse.value.reduce((n, e) => n + e.after.length, 0n)) } : null };
      results.push(row); console.error(dataset, round, layout, change, row.diff.ms.toFixed(1), row.diff.gets, (row.diff.bytes / 1024).toFixed(1), row.diff.replacementBytes);
    }
  }
}
console.log('{"runtime":'+JSON.stringify(Bun.version)+',"size":'+size+',"rounds":'+rounds+',"link":'+JSON.stringify(link ? { latencyMs:25, sharedMiBps:20, concurrentGETs:4 } : null)+',"results":[\n'+results.map(x => JSON.stringify(x)).join(',\n')+'\n]}');
