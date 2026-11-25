import { test, expect } from "bun:test";
import { Basin, MemoryStorage, concat, capability, link } from "./structures/core";
import { TrieBytes } from "./structures/trie-bytes";
import { ProllyTreelist, chunkBytes } from "./structures/prolly-treelist";
import { diffBytes, type ByteSequence, type ByteEdit } from "./structures/byte-diff";
const data = (n: number) => { let x = 12345; return Uint8Array.from({ length: n }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 24; }); };
const basin = () => new Basin(new MemoryStorage(), { seed: new Uint8Array(32).fill(42) });
async function patch(bytes: Uint8Array, next: ByteSequence, edits: ByteEdit[]) {
  const chunks: Uint8Array[] = []; let at = 0, newAt = 0;
  for (const e of edits) {
    expect(e.before.start >= BigInt(at)).toBe(true);
    expect(e.after.start - BigInt(newAt)).toBe(e.before.start - BigInt(at));
    chunks.push(bytes.slice(at, Number(e.before.start)), await next.read(e.after.start, Number(e.after.length)));
    at = Number(e.before.start + e.before.length); newAt = Number(e.after.start + e.after.length);
  }
  return concat([...chunks, bytes.slice(at)]);
}
test("hash-pruned trie and keyless treelist diffs reconstruct matching shifted files", async () => {
  for (const tight of [false, true]) {
    const b = basin(), bytes = data(300000), trie = await TrieBytes.build(b, bytes, tight, 1024), list = await ProllyTreelist.build(b, [bytes]);
    for (const [at, remove, add] of [[0, 0, data(7)], [100000, 0, data(39)], [120000, 29, new Uint8Array()], [bytes.length, 0, data(900)], [0, bytes.length, new Uint8Array()]] as const) {
      const expected = concat([bytes.slice(0, at), add, bytes.slice(at + remove)]);
      const a = await trie.splice(BigInt(at), BigInt(remove), add), c = await list.splice(BigInt(at), BigInt(remove), add);
      expect(a.tree.root).toEqual((await TrieBytes.build(b, expected, tight, 1024)).tree.root);
      for (const [old, next] of [[trie.sequence(), a.sequence()], [list.sequence(), c.sequence()], [trie.sequence(), c.sequence()]] as const) {
        b.clearCache(); expect(await patch(bytes, next, await diffBytes(old, next))).toEqual(expected);
      }
    }
  }
});
test("same chunker under trie and treelist routing preserves bytes and all generated edits", async () => {
  const b = basin(), options = { min: 32, target: 128, max: 512, branchTarget: 4, branchMax: 8 };
  let bytes: Uint8Array = data(3000), prior = await TrieBytes.chunks(b, chunkBytes([bytes], options), true), list = await ProllyTreelist.build(b, [bytes], options);
  let x = 9845;
  for (let i = 0; i < 35; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    const at = (x >>> 0) % (bytes.length + 1), remove = Math.min(i % 17, bytes.length - at), add = data(i % 13);
    const target = concat([bytes.slice(0, at), add, bytes.slice(at + remove)]), next = await TrieBytes.chunks(b, chunkBytes([target], options), true);
    const nextList = await list.splice(BigInt(at), BigInt(remove), add);
    expect(await patch(bytes, next.sequence(), await prior.diff(next))).toEqual(target);
    expect(await patch(bytes, nextList.sequence(), await diffBytes(prior.sequence(), nextList.sequence()))).toEqual(target);
    expect(await next.read(0n, target.length)).toEqual(target);
    bytes = target; prior = next; list = nextList;
  }
});
test("content comparison remains correct across independent allocations and damaged storage rejects", async () => {
  const bytes = data(200000), b = basin(), other = new Basin(new MemoryStorage(), { seed: new Uint8Array(32).fill(99) });
  const a = await TrieBytes.build(b, bytes, true), c = await TrieBytes.build(other, bytes, true);
  expect(await a.diff(c)).toEqual([]);
  const storage = b.storage as MemoryStorage, object = storage.objects.get(capability(link(a.tree.root)))!;
  object.bytes[0] ^= 1; b.clearCache();
  await expect(a.read(0n, bytes.length)).rejects.toThrow();
});
test("local refinement separates nearby changes instead of replacing unchanged middle bytes", async () => {
  const b = basin(), bytes = data(12000), target = bytes.slice(); target[100] ^= 255; target[9000] ^= 255;
  const a = await ProllyTreelist.build(b, [bytes]), c = await ProllyTreelist.build(b, [target]);
  const edits = await a.diff(c);
  expect(edits.reduce((n, e) => n + e.after.length, 0n)).toBe(2n);
  expect(await patch(bytes, c.sequence(), edits)).toEqual(target);
  const coarse = await diffBytes(a.sequence(), c.sequence(), 65536, 0);
  expect(coarse.reduce((n, e) => n + e.after.length, 0n)).toBe(8901n);
});
test("bounded local scripts match an independent edit-distance model and fall back safely", async () => {
  const { localByteDiff } = await import("./structures/local-byte-diff");
  let x = 67582;
  for (let n = 0; n < 160; n++) {
    const random = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
    const a = Uint8Array.from({ length: random() % 22 }, () => random() % 5), b = Uint8Array.from({ length: random() % 22 }, () => random() % 5);
    const dp = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : Math.min(dp[i - 1][j], dp[i][j - 1]) + 1;
    const edits = localByteDiff(a, b)!;
    expect(edits.reduce((n, e) => n + Number(e.before.length + e.after.length), 0)).toBe(dp[a.length][b.length]);
    const sequence: ByteSequence = { root: { size: BigInt(b.length), rank: 0, expand: async () => [] }, read: async (at, n) => b.slice(Number(at), Number(at) + n) };
    expect(await patch(a, sequence, edits)).toEqual(b);
  }
  expect(localByteDiff(new Uint8Array(500).fill(1), new Uint8Array(500).fill(2), 8)).toBeNull();
});
test("uniform byte summaries skip different chunk boundaries while preserving exact patches", async () => {
  const b = basin(), bytes = new Uint8Array(2 * 1024 * 1024), a = await ProllyTreelist.build(b, [bytes]);
  const c = await a.insert(1000000n, new Uint8Array([99]));
  const edits = await a.diff(c);
  expect(edits).toEqual([{ before: { start: 1000000n, length: 0n }, after: { start: 1000000n, length: 1n } }]);
  expect(await patch(bytes, c.sequence(), edits)).toEqual(concat([bytes.slice(0, 1000000), new Uint8Array([99]), bytes.slice(1000000)]));
  const different = await ProllyTreelist.build(b, [bytes], { min: 1024, target: 4096, max: 8192 });
  b.clearCache(); (b.storage as MemoryStorage).reads = 0;
  expect(await a.diff(different)).toEqual([]);
  expect((b.storage as MemoryStorage).reads).toBe(0);
  expect((await c.remove(1000000n, 1n)).root).toEqual(a.root);
});
test("uniform-side diff isolates dispersed changes without replacing the unchanged run between them", async () => {
  const b = basin(), bytes = new Uint8Array(2 * 1024 * 1024), target = bytes.slice();
  for (let i = 0; i < 8; i++) target[100000 + i * 200000] = 77;
  const a = await ProllyTreelist.build(b, [bytes]), c = await ProllyTreelist.build(b, [target]);
  const edits = await a.diff(c);
  expect(edits.reduce((n, e) => n + e.after.length, 0n)).toBe(8n);
  expect(await patch(bytes, c.sequence(), edits)).toEqual(target);
  expect(await patch(target, a.sequence(), await c.diff(a))).toEqual(bytes);
  const truncated = await ProllyTreelist.build(b, [target.slice(0, 1900000)]);
  expect(await patch(bytes, truncated.sequence(), await a.diff(truncated))).toEqual(target.slice(0, 1900000));
});
test("run-boundary lookahead reuses the unchanged suffix instead of reading and rehashing it", async () => {
  const b = basin(), bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => Math.floor(i / 16384) % 251);
  const a = await ProllyTreelist.build(b, [bytes]); b.clearCache(); const store = b.storage as MemoryStorage; store.reads = 0;
  const next = await a.splice(1000000n, 1n, new Uint8Array([255]));
  const reads = store.reads;
  const expected = bytes.slice(); expected[1000000] = 255;
  expect(next.root).toEqual((await ProllyTreelist.build(b, [expected])).root);
  expect(reads).toBeLessThan(10);
});
test("bounded equal-length refinement isolates scattered writes even without uniform summaries", async () => {
  const b = basin(), bytes = new Uint8Array(2 * 1024 * 1024), target = bytes.slice();
  for (let i = 0; i < 8; i++) target[100000 + i * 200000] = 77;
  const a = await ProllyTreelist.build(b, [bytes]), c = await ProllyTreelist.build(b, [target]);
  const edits = await diffBytes(a.sequence(false), c.sequence(false));
  expect(edits.reduce((n, e) => n + e.after.length, 0n)).toBe(8n);
  expect(await patch(bytes, c.sequence(false), edits)).toEqual(target);
});
test("uniform-run descriptor limit falls back to a reconstructable coarse diff", async () => {
  const b = basin(), bytes = new Uint8Array(20000), target = Uint8Array.from({ length: bytes.length }, (_, i) => i % 2);
  const a = await ProllyTreelist.build(b, [bytes]), c = await ProllyTreelist.build(b, [target]);
  expect(await patch(bytes, c.sequence(), await a.diff(c))).toEqual(target);
});
