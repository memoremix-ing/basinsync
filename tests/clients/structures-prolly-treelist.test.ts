import { test, expect } from "bun:test";
import { Basin, MemoryStorage, concat, hex } from "./structures/core";
import { ProllyTreelist, type FileEdit } from "./structures/prolly-treelist";
const data = (n: number, seed = 0x13579bdf) => Uint8Array.from({ length: n }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 24; });
const setup = (seed = 42) => { const storage = new MemoryStorage(); return { storage, basin: new Basin(storage, { seed: new Uint8Array(32).fill(seed) }) }; };
async function patch(before: Uint8Array, after: ProllyTreelist, edits: FileEdit[]) {
  const chunks: Uint8Array[] = []; let at = 0;
  for (const e of edits) {
    expect(e.before.start >= BigInt(at)).toBe(true);
    chunks.push(before.slice(at, Number(e.before.start)), await after.read(e.after.start, Number(e.after.length)));
    at = Number(e.before.start + e.before.length);
  }
  chunks.push(before.slice(at)); return concat(chunks);
}
test("file content identities ignore input page partitions and storage allocations", async () => {
  const bytes = data(200000), a = setup(), b = setup(99);
  const left = await ProllyTreelist.build(a.basin, [bytes]);
  const right = await ProllyTreelist.build(b.basin, Array.from({ length: 200 }, (_, i) => bytes.slice(i * 1000, (i + 1) * 1000)));
  expect(left.summary.content).toEqual(right.summary.content);
  expect(left.root[6].entropy).not.toEqual(right.root[6].entropy);
  a.basin.clearCache(); b.basin.clearCache(); a.storage.reads = 0; b.storage.reads = 0;
  expect(await left.diff(right)).toEqual([]);
  expect(a.storage.reads + b.storage.reads).toBe(0);
});
test("file diffs reconstruct overwrite, append, insertion, deletion, empty and repeated contents", async () => {
  const { basin } = setup(), original = data(2 * 1024 * 1024);
  const file = await ProllyTreelist.build(basin, [original]);
  for (const [at, remove, insert] of [[1000000, 1, new Uint8Array([99])], [original.length, 0, data(39)], [123456, 0, data(37)], [77777, 100000, new Uint8Array()], [0, original.length, new Uint8Array()]] as const) {
    const expected = concat([original.slice(0, at), insert, original.slice(at + remove)]);
    const next = await file.splice(BigInt(at), BigInt(remove), insert);
    const canonical = await ProllyTreelist.build(basin, [expected]);
    expect(next.root).toEqual(canonical.root);
    basin.clearCache();
    const edits = await file.diff(next);
    expect(await patch(original, next, edits)).toEqual(expected);
    expect(await next.read(0n, expected.length)).toEqual(expected);
    expect(await file.read(0n, original.length)).toEqual(original);
  }
  const zero = await ProllyTreelist.build(basin, [new Uint8Array(1000000)]);
  const next = await zero.splice(500000n, 0n, new Uint8Array([99]));
  expect(await patch(new Uint8Array(1000000), next, await zero.diff(next))).toEqual(concat([new Uint8Array(500000), new Uint8Array([99]), new Uint8Array(500000)]));
});
test("generated file histories have canonical roots and valid diffs", async () => {
  const { basin } = setup(); const options = { min: 32, target: 128, max: 512, branchTarget: 4, branchMax: 8 };
  let model: Uint8Array = data(2000); let file = await ProllyTreelist.build(basin, [model], options);
  let random = 0x12345678;
  for (let i = 0; i < 50; i++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    const at = (random >>> 0) % (model.length + 1), remove = Math.min(i % 23, model.length - at), add = data(i % 29, i + 999);
    const expected = concat([model.slice(0, at), add, model.slice(at + remove)]);
    const next = await file.splice(BigInt(at), BigInt(remove), add);
    expect(next.root).toEqual((await ProllyTreelist.build(basin, [expected], options)).root);
    expect(await patch(model, next, await file.diff(next, 4096))).toEqual(expected);
    model = expected; file = next;
  }
});
test("unchanged subtrees avoid leaf downloads; diff spans are byte addresses", async () => {
  const { basin, storage } = setup(), original = data(8 * 1024 * 1024);
  const before = await ProllyTreelist.build(basin, [original]);
  const after = await before.splice(4000000n, 1n, new Uint8Array([original[4000000] ^ 255]));
  basin.clearCache(); storage.reads = 0;
  const edits = await before.diff(after);
  expect(edits).toEqual([{ before: { start: 4000000n, length: 1n }, after: { start: 4000000n, length: 1n } }]);
  expect(storage.reads).toBeLessThan(40);
  await expect(before.splice(-1n, 0n, new Uint8Array())).rejects.toThrow();
});
test("incompatible chunk policies compare bytes rather than trusting CRC equality", async () => {
  const { basin } = setup(), bytes = data(50000);
  const a = await ProllyTreelist.build(basin, [bytes]);
  const b = await ProllyTreelist.build(basin, [bytes], { min: 1024, target: 4096, max: 16384 });
  expect(a.summary.content).not.toEqual(b.summary.content);
  expect(await a.diff(b)).toEqual([]);
});
test("windowed refinement avoids a multi-megabyte patch for a one-byte zero-run insertion", async () => {
  const { basin } = setup(), bytes = new Uint8Array(4 * 1024 * 1024);
  const a = await ProllyTreelist.build(basin, [bytes]);
  const b = await a.splice(2000000n, 0n, new Uint8Array([99]));
  expect(await a.diff(b, 4096)).toEqual([{ before: { start: 2000000n, length: 0n }, after: { start: 2000000n, length: 1n } }]);
  expect(await patch(bytes, b, await a.diff(b, 0))).toEqual(concat([bytes.slice(0, 2000000), new Uint8Array([99]), bytes.slice(2000000)]));
});
test("dispersed and shifted edits reconstruct in both directions", async () => {
  const { basin } = setup(), bytes = data(300000);
  const a = await ProllyTreelist.build(basin, [bytes]);
  const expected = concat([bytes.slice(0, 1234), data(19), bytes.slice(1270, 100000), data(77), bytes.slice(100000, 250000), bytes.slice(250101)]);
  const b = await ProllyTreelist.build(basin, [expected]);
  expect(await patch(bytes, b, await a.diff(b))).toEqual(expected);
  expect(await patch(expected, a, await b.diff(a))).toEqual(bytes);
});
test("valid physical storage cannot conceal an inconsistent logical content digest", async () => {
  const { basin } = setup();
  const { built } = await import("./structures/packed");
  const { hash } = await import("./structures/crc64nvme");
  const bytes = data(100);
  const file = await ProllyTreelist.build(basin, [bytes]);
  const forged = built(basin, ".prolly-treelist/", file.root[5], [0, { size: 100n, uniform: null, crc64nvme: hash(bytes), content: new Uint8Array(48) }, bytes, null], []);
  const edge = await basin.seal(forged.node, []);
  await expect(new ProllyTreelist(basin, edge).read(0n, 100)).rejects.toThrow();
});
test("editing exactly at a run boundary revisits its predecessor for canonical packing", async () => {
  const { basin } = setup();
  const bytes = concat([new Uint8Array(16384).fill(1), new Uint8Array(16384).fill(2), new Uint8Array(16384).fill(3)]);
  const file = await ProllyTreelist.build(basin, [bytes]);
  for (const [remove, add] of [[0, new Uint8Array([1])], [16384, new Uint8Array()]] as const) {
    const expected = concat([bytes.slice(0, 16384), add, bytes.slice(16384 + remove)]);
    const next = await file.splice(16384n, BigInt(remove), add);
    expect(next.root).toEqual((await ProllyTreelist.build(basin, [expected])).root);
    expect(await patch(bytes, next, await file.diff(next))).toEqual(expected);
  }
});
