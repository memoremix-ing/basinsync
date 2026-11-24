import { test, expect } from "bun:test";
import { Basin, MemoryStorage } from "./structures/core";
import { BTree } from "./structures/btree";
import { plain } from "./structures/trie";
const seed = new Uint8Array(32).fill(42),
  k = (i: number) => i.toString(16).padStart(8, "0");
test("B-tree selective replacements reuse canonical sibling objects", async () => {
  const s = new MemoryStorage(),
    b = new Basin(s, { seed });
  const original = await BTree.build(
    b,
    Array.from({ length: 100000 }, (_, i) => [k(i), i]),
    plain,
  );
  const edited = (await original.edit()).set(k(23456), -1);
  s.reads = 0;
  let puts = 0;
  const put = s.put.bind(s);
  s.put = async (...args) => {
    puts++;
    return put(...args);
  };
  const stored = await edited.store(),
    reads = s.reads,
    writeCalls = puts;
  const canonical = await BTree.build(b, [...edited.entries()], plain);
  expect(stored.root[6].sha384).toEqual(canonical.root[6].sha384);
  expect(reads).toBeLessThan(20);
  expect(writeCalls).toBeLessThan(10);
  expect(await stored.get(k(23456))).toBe(-1);
  expect(await original.get(k(23456))).toBe(23456);
});
test("rank shifts, empty roots and legacy callback semantics stay canonical", async () => {
  for (const n of [0, 1, 15, 31, 32, 255, 1023, 1024, 1280, 1281, 5000]) {
    const b = new Basin(new MemoryStorage(), { seed });
    const c = {
      ...plain,
      entry: (_k: Uint8Array, v: number) => String(v),
      combine: (p: readonly string[]) => p.join(","),
      empty: "",
    };
    for (const consumer of [plain, c]) {
      const t = await BTree.build(
        b,
        Array.from({ length: n }, (_, i) => [k(i * 2), i]),
        consumer as any,
      );
      let edit = await t.edit();
      edit = edit
        .set(k(5), -1)
        .delete(k(0))
        .set(k(n * 2 + 1), -2);
      const got = await edit.store(),
        want = await BTree.build(b, edit.entries(), consumer as any);
      expect(got.root[6].sha384).toEqual(want.root[6].sha384);
    }
  }
});
test("selective B-tree summaries preserve asynchronous ordered composition", async () => {
  const { composableConsumer } = await import("./structures/trie"),
    { hex } = await import("./structures/core");
  const c = composableConsumer<number, string>({
    migration: 3,
    empty: "",
    entry: async (k, v) => `${hex(k)}:${v};`,
    combine: async (p) => p.join(""),
  });
  const b = new Basin(new MemoryStorage(), { seed }),
    tree = await BTree.build(
      b,
      Array.from({ length: 3000 }, (_, i) => [k(i * 2), i]),
      c,
    );
  const edit = (await tree.edit())
    .set(k(13), -1)
    .set(k(2000), -2)
    .delete(k(3000));
  const got = await edit.store(),
    want = await BTree.build(b, edit.entries(), c);
  expect(got.root[6].sha384).toEqual(want.root[6].sha384);
});
test("seeded rank edits and packing-policy changes retain canonical B-tree bytes", async () => {
  const b = new Basin(new MemoryStorage(), { seed });
  let tree = await BTree.build(
      b,
      Array.from({ length: 5000 }, (_, i) => [k(i * 2), i]),
      plain,
    ),
    x = 97;
  for (let round = 0; round < 20; round++) {
    let edit = await tree.edit();
    for (let i = 0; i < 25; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      const id = k(x % 12000);
      edit = i % 3 ? edit.set(id, x) : edit.delete(id);
    }
    if (round === 10) b.options.maxDegree = 64;
    const got = await edit.store(),
      want = await BTree.build(b, edit.entries(), plain);
    expect(got.root[6].sha384).toEqual(want.root[6].sha384);
    tree = got;
  }
});
