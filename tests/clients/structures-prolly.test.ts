import { test, expect } from "bun:test";
import { Basin, MemoryStorage, utf8, hex, concat, type Edge } from "./structures/core";
import { ProllyPages } from "./structures/prolly";
import * as crc from "./structures/crc64nvme";
import { sectors } from "./structures/volume";
const k = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const modelBytes = (model: Map<number, Uint8Array>) => concat([...model].sort(([a], [b]) => a - b).map(([, b]) => b));
const setup = () => { const s = new MemoryStorage(); return { s, b: new Basin(s, { seed: new Uint8Array(32).fill(42) }) }; };
test("prolly byte ranges match concatenated variable-sized pages, including empty pages", async () => {
  const { b } = setup(), model = new Map<number, Uint8Array>();
  for (let i = 0; i < 240; i++) model.set(i * 16, new Uint8Array(i % 19).fill(i));
  const tree = await ProllyPages.build(b, [...model].map(([i, bytes]) => [k(i), bytes]), { target: 4, min: 2, max: 8, maxBytes: 100, branchTarget: 4, branchMax: 8 });
  const expected = modelBytes(model);
  expect(tree.summary.size).toBe(BigInt(expected.length));
  expect(tree.summary.count).toBe(240n);
  expect(tree.summary.crc64nvme).toEqual(crc.hash(expected));
  for (let start = 0; start <= expected.length + 9; start += 17) {
    b.clearCache();
    expect(await tree.read(BigInt(start), 39)).toEqual(expected.slice(start, start + 39));
  }
  expect(await tree.get(k(16))).toEqual(model.get(16)!);
  expect(await tree.get(k(17))).toBeUndefined();
  await expect(tree.read(-1n, 1)).rejects.toThrow();
  await expect(tree.read(0n, 2 ** 30)).rejects.toThrow();
});
test("prolly edit sequences remain canonical and preserve snapshots", async () => {
  const { b } = setup(), options = { target: 4, min: 2, max: 8, maxBytes: 64, branchTarget: 4, branchMax: 8 };
  const model = new Map<number, Uint8Array>();
  let tree = await ProllyPages.build(b, [], options);
  let random = 0x13579bdf;
  const snapshots: { root: Edge; bytes: Uint8Array }[] = [];
  for (let round = 0; round < 70; round++) {
    const changes: [Uint8Array, Uint8Array | null][] = [];
    for (let j = 0; j < 5; j++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      const id = (random >>> 0) % 100, value = j === 2 ? null : new Uint8Array((random >>> 8) % 21).fill(round);
      changes.push([k(id), value]);
      if (value === null) model.delete(id); else model.set(id, value);
    }
    tree = await tree.update(changes);
    const full = await ProllyPages.build(b, [...model].map(([i, bytes]) => [k(i), bytes]), options);
    expect(tree.root).toEqual(full.root);
    expect(await tree.read(0n, 10000)).toEqual(modelBytes(model));
    expect(tree.summary.crc64nvme).toEqual(crc.hash(modelBytes(model)));
    if (round % 15 === 0) snapshots.push({ root: tree.root, bytes: modelBytes(model) });
  }
  for (const snapshot of snapshots) expect(await new ProllyPages(b, snapshot.root).read(0n, 10000)).toEqual(snapshot.bytes);
  tree = await tree.update([...model.keys()].map(id => [k(id), null]));
  expect(tree.root).toEqual((await ProllyPages.build(b, [], options)).root);
});
test("fixed-size edits fetch only the changed leaf and routing, retaining other objects", async () => {
  const { b, s } = setup();
  const tree = await ProllyPages.build(b, Array.from({ length: 1600 }, (_, i) => [k(i * 16), new Uint8Array(128).fill(i)] as [Uint8Array, Uint8Array]));
  const before = new Set(s.objects.keys());
  b.clearCache(); s.reads = 0;
  const next = await tree.update([[k(777 * 16), new Uint8Array(128).fill(99)]]);
  expect(s.reads).toBeLessThan(30);
  expect([...s.objects.keys()].filter(k => !before.has(k)).length).toBeLessThan(10);
  expect(await next.get(k(777 * 16))).toEqual(new Uint8Array(128).fill(99));
  expect(await tree.get(k(777 * 16))).toEqual(new Uint8Array(128).fill(777));
  expect((await next.update([])).root).toBe(next.root);
  const input = new Uint8Array([1, 2]);
  const owned = await ProllyPages.build(b, [[k(1), input]]);
  input.fill(9);
  const read = (await owned.get(k(1)))!; read.fill(7);
  expect(await owned.get(k(1))).toEqual(new Uint8Array([1, 2]));
});

test("the existing trie can navigate packed bytes with size summaries too", async () => {
  const { Trie, composableConsumer } = await import("./structures/trie");
  const { readPageBytes } = await import("./structures/page-range");
  const { b } = setup();
  const consumer = composableConsumer({ ...sectors, trieInlineCost: () => 320 }, { keyIndependent: true });
  const rows: [Uint8Array, [Uint8Array]][] = Array.from({ length: 600 }, (_, i) => [k(i * 16), [new Uint8Array(i % 27).fill(i)]]);
  const trie = await Trie.build(b, rows, consumer), expected = concat(rows.map(([, [b]]) => b));
  for (const at of [0, 9, 130, 777, expected.length - 12, expected.length + 1]) {
    b.clearCache();
    expect(await readPageBytes(trie, BigInt(at), 32)).toEqual(expected.slice(at, at + 32));
  }
});

test("resizing the next page can undo the predecessor's byte-cap boundary", async () => {
  const { b } = setup(), policy = { maxBytes: 32 };
  const rows: [Uint8Array, Uint8Array][] = Array.from({ length: 6 }, (_, i) => [k(i), new Uint8Array(20).fill(i)]);
  const old = await ProllyPages.build(b, rows, policy);
  const next = await old.update([[k(1), new Uint8Array([99])]]);
  rows[1][1] = new Uint8Array([99]);
  expect(next.root).toEqual((await ProllyPages.build(b, rows, policy)).root);
  expect(await next.read(0n, 1000)).toEqual(concat(rows.map(([, v]) => v)));
  expect((await old.read(0n, 1000)).length).toBe(120);
});
test("prolly zero-size pages, malformed input and object corruption fail safely", async () => {
  const { b, s } = setup();
  const tree = await ProllyPages.build(b, Array.from({ length: 900 }, (_, i) => [k(i), new Uint8Array()] as [Uint8Array, Uint8Array]));
  b.clearCache(); s.reads = 0;
  expect(await tree.read(0n, 1)).toEqual(new Uint8Array());
  expect(s.reads).toBe(0);
  expect(await tree.get(k(456))).toEqual(new Uint8Array());
  await expect(ProllyPages.build(b, [[k(1), new Uint8Array()], [k(1), new Uint8Array()]])).rejects.toThrow();
  await expect(ProllyPages.build(b, [[k(1), new Uint8Array(33)]], { maxBytes: 32 })).rejects.toThrow();
  await expect(ProllyPages.build(b, [], { branchMax: 400 })).rejects.toThrow();
  const address = (await import("./structures/core")).capability((await import("./structures/core")).link(tree.root));
  s.objects.get(address)!.bytes[0] ^= 1;
  b.clearCache();
  await expect(tree.get(k(456))).rejects.toThrow();
});
