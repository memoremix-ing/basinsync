import { test, expect } from "bun:test";
import { Basin, MemoryStorage, key, hex, utf8 } from "./structures/core";
import { BPlusTree, type BPlusOptions } from "./structures/bplus";
import { plain } from "./structures/trie";
import { resolveOperation } from "./structures/operation";
const seed = new Uint8Array(32).fill(42),
  k = (i: number) => i.toString(16).padStart(8, "0");
test("B+tree versions, configurable branches/leaves and separator equality preserve ordered values", async () => {
  for (const n of [0, 1, 31, 32, 127, 128, 1280, 1281, 10000])
    for (const options of [
      { leafKeys: 31, branchChildren: 32 },
      { leafKeys: 127, branchChildren: 128 },
      { leafKeys: 17, branchChildren: 8, leafInline: 64, branchInline: 128 },
    ]) {
      const s = new MemoryStorage(),
        b = new Basin(s, { seed }),
        rows = Array.from(
          { length: n },
          (_, i) => [k(i), i % 7 ? i : null] as [string, number | null],
        );
      const t = await BPlusTree.build(b, rows, plain, options),
        back = await BPlusTree.build(b, rows.toReversed(), plain, options);
      expect(t.root[6].sha384).toEqual(back.root[6].sha384);
      const read = new BPlusTree(new Basin(s, { seed }), t.root, plain);
      for (const i of [0, 1, 16, 30, 31, 32, 126, 127, 128, n - 1].filter(
        (i) => i >= 0 && i < n,
      ))
        expect(await read.get(k(i))).toBe(rows[i][1]);
      expect(await read.get(k(n))).toBeUndefined();
      const entries = [];
      for await (const [id, v] of read.entries(k(12), k(150)))
        entries.push([hex(id), v]);
      expect(entries).toEqual(rows.slice(12, 150));
    }
});
test("B+tree hints skip stored index levels, validate identity and fall back when unavailable", async () => {
  const s = new MemoryStorage(),
    b = new Basin(s, { seed }),
    rows = Array.from(
      { length: 10000 },
      (_, i) => [k(i), i] as [string, number],
    );
  const t = await BPlusTree.build(b, rows, plain, {
    leafKeys: 31,
    branchChildren: 16,
    leafInline: 64,
    branchInline: 32,
  });
  let reader = new BPlusTree(new Basin(s, { seed }), t.root, plain);
  s.reads = 0;
  expect(await reader.get(k(0))).toBe(0);
  const direct = s.reads;
  reader = new BPlusTree(new Basin(s, { seed }), t.root, plain);
  s.reads = 0;
  expect(await reader.get(k(0), { shortcuts: true })).toBe(0);
  expect(s.reads).toBeLessThan(direct);
  const resolve = s.resolve.bind(s);
  s.resolve = async () => undefined;
  expect(
    await new BPlusTree(new Basin(s, { seed }), t.root, plain).get(k(9999), {
      shortcuts: true,
    }),
  ).toBe(9999);
  s.resolve = resolve;
  const op = new BPlusTree(new Basin(s, { seed }), t.root, plain).getOrDefer(
    k(2222),
  );
  expect(typeof op).toBe("function");
  expect(await resolveOperation(op)).toBe(2222);
});
test("B+tree aggregates keys and values in order, rejects duplicates and supports generic payloads", async () => {
  const b = new Basin(new MemoryStorage(), { seed }),
    c = {
      ...plain,
      entry: (k: Uint8Array) => hex(k),
      combine: (p: readonly string[]) => p.join(","),
      empty: "",
    };
  const rows = Array.from(
    { length: 50 },
    (_, i) => [k(i), { data: utf8(`v${i}`) }] as [string, unknown],
  );
  const t = await BPlusTree.build(b, rows, c, {
    leafKeys: 3,
    branchChildren: 4,
  });
  expect(t.root[6][1]).toBe(rows.map(([k]) => k).join(","));
  expect(await t.get(k(23))).toEqual(rows[23][1]);
  await expect(
    BPlusTree.build(
      b,
      [
        ["00", 1],
        ["00", 2],
      ],
      plain,
    ),
  ).rejects.toThrow();
  await expect(
    BPlusTree.build(b, [], plain, { branchChildren: 1 }),
  ).rejects.toThrow("fanout");
});

test("B+tree summary pruning avoids GETs and stale hints cannot redirect reads", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed }),
    tree = await BPlusTree.build(
      b,
      Array.from({ length: 1000 }, (_, i) => [k(i), i]),
      plain,
      { leafKeys: 7, branchChildren: 8, leafInline: 16, branchInline: 16 },
    );
  const reader = new BPlusTree(new Basin(storage, { seed }), tree.root, plain);
  storage.reads = 0;
  const rows = [];
  for await (const row of reader.entries(undefined, undefined, () => false))
    rows.push(row);
  expect(rows).toEqual([]);
  expect(storage.reads).toBe(0);
  storage.resolve = async () => tree.root;
  expect(await reader.get(k(0), { shortcuts: true })).toBe(0);
});
