/** Actual byte diffs: hierarchical strong-content comparison versus full-read scanning. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Basin, MemoryStorage, concat, type Edge, type PendingEdge, type Storage } from "./structures/core";
import { ProllyFile, type FileEdit } from "./structures/prolly-file";
class Meter implements Storage {
  store = new MemoryStorage(); stats = { gets: 0, bytes: 0, puts: 0, newBytes: 0, newObjects: 0 };
  reset() { this.stats = { gets: 0, bytes: 0, puts: 0, newBytes: 0, newObjects: 0 }; }
  async get(e: Edge) { const b = await this.store.get(e); this.stats.gets++; this.stats.bytes += b.length; return b; }
  async put(e: PendingEdge, b: Uint8Array, edges: readonly Edge[]) { this.stats.puts++; const n = this.store.objects.size, revision = await this.store.put(e, b, edges); if (this.store.objects.size > n) { this.stats.newBytes += b.length; this.stats.newObjects++; } return revision; }
}
function random(n: number) { let x = 0x13579bdf; return Uint8Array.from({ length: n }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 24; }); }
const size = Number(Bun.env.FILE_DIFF_BYTES ?? 8 * 1024 * 1024), rounds = Number(Bun.env.FILE_DIFF_ROUNDS ?? 3), results: any[] = [];
for (const dataset of ["random", "page-runs", "zeros"] as const) {
  const original = dataset === "random" ? random(size) : Uint8Array.from({ length: size }, (_, i) => dataset === "zeros" ? 0 : Math.floor(i / 16384) % 251);
  for (let round = 0; round < rounds; round++) for (const runAnchors of round % 2 ? [true, false] : [false, true]) {
    const meter = new Meter(), basin = new Basin(meter, { seed: new Uint8Array(32).fill(42) });
    const measure = async <T>(f: () => Promise<T>) => { basin.clearCache(); meter.reset(); const start = performance.now(), value = await f(); return { value, ms: performance.now() - start, ...meter.stats }; };
    const build = await measure(() => ProllyFile.build(basin, [original], { runAnchors })), before = build.value;
    for (const change of ["same", "overwrite", "append", "insert", "delete"] as const) {
      const at = change === "append" ? size : Math.floor(size / 2) + 37;
      const remove = change === "overwrite" || change === "delete" ? 1 : 0;
      const add = change === "same" || change === "delete" ? new Uint8Array() : change === "append" ? random(16384) : new Uint8Array([original[at] ^ 255]);
      const expected = change === "same" ? original : concat([original.slice(0, at), add, original.slice(at + remove)]);
      const update = await measure(() => change === "same" ? Promise.resolve(before) : before.splice(BigInt(at), BigInt(remove), add));
      const after = update.value;
      const diff = await measure(() => before.diff(after));
      const patch = await measure(async () => {
        const chunks: Uint8Array[] = []; let cursor = 0;
        for (const e of diff.value) { chunks.push(original.slice(cursor, Number(e.before.start)), await after.read(e.after.start, Number(e.after.length))); cursor = Number(e.before.start + e.before.length); }
        chunks.push(original.slice(cursor)); return concat(chunks);
      });
      assert.deepEqual(patch.value, expected);
      const full = await measure(async () => {
        const left = await before.read(0n, original.length); basin.clearCache(); const right = await after.read(0n, expected.length);
        let a = 0, z = 0; while (a < Math.min(left.length, right.length) && left[a] === right[a]) a++;
        while (z < Math.min(left.length, right.length) - a && left[left.length - 1 - z] === right[right.length - 1 - z]) z++;
        return { oldStart: a, newStart: a, oldLength: left.length - a - z, newLength: right.length - a - z };
      });
      const omit = <T>(row: { value: T; [k: string]: unknown }) => { const { value, ...rest } = row; return rest; };
      results.push({ dataset, round, runAnchors, change, size, build: omit(build), update: omit(update), diff: { ...omit(diff), edits: diff.value.length, replacementBytes: Number(diff.value.reduce((n, e) => n + e.after.length, 0n)) }, patch: omit(patch), full: omit(full) });
      console.error(dataset, round, runAnchors ? 'run-aware' : 'gear', change, 'diff',diff.ms.toFixed(1),'GETs',diff.gets,'replacement',results.at(-1).diff.replacementBytes);
    }
  }
}
console.log(JSON.stringify({ runtime: Bun.version, size, rounds, results }, null, 2));
