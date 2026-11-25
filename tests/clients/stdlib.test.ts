import { vectors } from "./vectors";
const shared = vectors<{trieCounts: number[]; orderedCounts: number[]}>("structures");
import { test, expect } from "bun:test";
import {
  Basin,
  MemoryStorage,
  object,
  query,
  key,
  type Node,
} from "./structures/core";
import { Vector } from "./structures/vector";
import { BTree } from "./structures/btree";
import { count } from "./structure-fixture";
const seed = new Uint8Array(32).fill(42),
  rows = (n: number): [Uint8Array, unknown][] =>
    Array.from({ length: n }, (_, i) => [
      new Uint8Array([i >>> 16, (i >>> 8) & 255, i & 255]),
      i % 7 === 0 ? null : BigInt(i),
    ]);
test("vector bitmaps, packing, canonical rebuilds, sparse bigint indices and snapshots", async () => {
  for (const n of shared.orderedCounts) {
    const s = new MemoryStorage(),
      b = new Basin(s, { seed }),
      input = Array.from({ length: n }, (_, i) =>
        i % 7 === 0 ? null : BigInt(i),
      ),
      v = await Vector.build(b, input, count);
    expect(v.length).toBe(BigInt(n));
    expect(v.root[6][1]).toBe(BigInt(n));
    for (const i of [0, 15, 31, 32, 1023, n - 1].filter((i) => i >= 0 && i < n))
      expect(await v.get(BigInt(i))).toEqual(input[i]);
    expect(await v.get(BigInt(n))).toBeUndefined();
    const seen = [];
    for await (const r of v.entries()) seen.push(r);
    expect(seen).toEqual(input.map((v, i) => [BigInt(i), v]));
    const same = await Vector.buildEntries(
      b,
      BigInt(n),
      seen.toReversed(),
      count,
    );
    expect(same.root[6].sha384).toEqual(v.root[6].sha384);
    if (n > 0) {
      const next = await v.update([[0n, { set: "changed" }]]);
      expect(await next.get(0n)).toBe("changed");
      expect(await v.get(0n)).toEqual(input[0]);
    }
  }
  const b = new Basin(new MemoryStorage(), { seed }),
    far = 2n ** 200n + 31n,
    v = await Vector.buildEntries(
      b,
      far + 1n,
      [
        [0n, null],
        [31n, "last-bit"],
        [far, "far"],
      ],
      count,
    );
  expect(await v.get(31n)).toBe("last-bit");
  expect(await v.get(1n)).toBeUndefined();
  expect(await v.get(far)).toBe("far");
  const cut = await v.update([], 32n);
  expect(await cut.get(31n)).toBe("last-bit");
  expect((await cut.pop()).length).toBe(31n);
  expect(await (await cut.push("appended")).get(32n)).toBe("appended");
  let result = [];
  for await (const r of v.entries(31n, 32n)) result.push(r);
  expect(result).toEqual([[31n, "last-bit"]]);
  b.clearCache();
  (b.storage as MemoryStorage).reads = 0;
  for await (const _ of v.entries(0n, v.length, () => false))
    throw Error("unpruned");
  expect((b.storage as MemoryStorage).reads).toBe(0);
  await expect(Vector.buildEntries(b, 1n, [[1n, null]], count)).rejects.toThrow(
    "outside",
  );
  await expect(
    Vector.buildEntries(
      b,
      2n,
      [
        [0n, null],
        [0n, null],
      ],
      count,
    ),
  ).rejects.toThrow("duplicate");
}, 30000);
test("B-tree separator values, canonical collapse, ordered scans, lazy branches and pruning", async () => {
  for (const n of shared.orderedCounts) {
    const s = new MemoryStorage(),
      b = new Basin(s, { seed }),
      input = rows(n),
      tree = await BTree.build(b, input.toReversed(), count),
      same = await BTree.build(b, input, count);
    expect(tree.root[6].sha384).toEqual(same.root[6].sha384);
    expect(tree.root[6][1]).toBe(BigInt(n));
    for (const i of [0, 15, 31, 32, 1023, n - 1].filter((i) => i >= 0 && i < n))
      expect(await tree.get(input[i][0])).toEqual(input[i][1]);
    const seen = [];
    for await (const r of tree.entries()) seen.push(r);
    expect(seen).toEqual(input);
    if (n > 31) {
      const root = object<Node>(await b.load(tree.root)),
        separator = (root[6][2] as Uint8Array[])[0],
        value = (root[6][3] as unknown[])[0];
      b.clearCache();
      s.reads = 0;
      expect(await tree.get(separator)).toEqual(value);
      expect(s.reads).toBe(1);
      if (n > 1280) expect(s.objects.size).toBeGreaterThan(1);
    }
    if (n) {
      const next = await tree.update([[input[0][0], { delete: true }]]),
        fresh = await BTree.build(b, input.slice(1), count);
      expect(next.root[6].sha384).toEqual(fresh.root[6].sha384);
      expect(await tree.get(input[0][0])).toEqual(input[0][1]);
    }
  }
  const s = new MemoryStorage(),
    b = new Basin(s, { seed }),
    tree = await BTree.build(b, rows(4000), count),
    seen = [];
  for await (const row of tree.entries("00001f", "000041")) seen.push(row);
  expect(seen).toEqual(rows(4000).slice(31, 65));
  b.clearCache();
  s.reads = 0;
  for await (const _ of tree.entries("", undefined, () => false))
    throw Error("unpruned");
  expect(s.reads).toBe(0);
  expect(await tree.get("ffffff")).toBeUndefined();
  await expect(
    BTree.build(
      b,
      [
        ["", null],
        ["", 1],
      ],
      count,
    ),
  ).rejects.toThrow("duplicate");
}, 30000);

test("new structures keep borrowed views alive and reject malformed structural vectors", async () => {
  const s = new MemoryStorage(),
    b = new Basin(s, { seed }),
    blob = new Uint8Array([1, 2, 3]),
    v = await Vector.build(b, [blob], count),
    tree = await BTree.build(b, [["aa", blob]], count);
  const vr = (await v.getView(0n))!,
    br = (await tree.getView("aa"))!;
  const own = (await tree.get("aa")) as Uint8Array;
  own[0] = 9;
  b.clearCache();
  expect(br.blobValue()).toEqual(blob);
  expect(vr.blobValue()).toEqual(blob);
  const vn = object<Node>(await b.load(v.root));
  vn[6][3] = { slot: blob };
  const wrongVector = await b.seal(vn, []);
  await expect(new Vector(b, wrongVector, count).get(0n)).rejects.toThrow(
    "bitmap",
  );
  const bn = object<Node>(await b.load(tree.root));
  bn[6][2] = { key: new Uint8Array([0xaa]) };
  const wrongTree = await b.seal(bn, []);
  await expect(new BTree(b, wrongTree, count).get("aa")).rejects.toThrow(
    "node",
  );
  const unsupported = [...tree.root] as typeof tree.root;
  unsupported[4] = 1 as 0;
  expect(() => new BTree(b, unsupported, count)).toThrow("unsupported");
});
