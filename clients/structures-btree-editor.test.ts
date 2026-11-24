import { test, expect } from "bun:test";
import { Basin, MemoryStorage, hex, type Edge } from "./structures/core";
import { BTree, BTreeMap, BTreeEditor } from "./structures/btree";
import { plain } from "./structures/trie";
import { resolveOperation } from "./structures/operation";
const seed = new Uint8Array(32).fill(42);
const k = (i: number) => i.toString(16).padStart(8, "0");
test("persistent B-tree splits, borrows, merges and collapses without changing snapshots", () => {
  let tree = BTreeMap.empty<number | null | undefined>();
  for (let i = 0; i < 10000; i++) tree = tree.set(k(i), i);
  const held = tree;
  tree.validate();
  // Alternating ends and separator deletions exercise both sibling directions.
  for (let i = 0; i < 10000; i++) {
    const at = i % 2 ? 9999 - (i >>> 1) : i >>> 1;
    tree = tree.delete(k(at));
    if (i % 97 === 0) {
      tree.validate();
      expect(tree.size).toBe(9999 - i);
    }
  }
  tree.validate();
  expect(tree.size).toBe(0);
  expect(held.size).toBe(10000);
  expect(held.get(k(5555))).toBe(5555);
  expect(tree.delete("ffff")).toBe(tree);
  const bytes = Buffer.from([1, 2]);
  tree = tree.set(bytes, undefined);
  bytes[0] = 9;
  expect(tree.has("0102")).toBe(true);
  expect(tree.get("0102")).toBeUndefined();
  const returned = [...tree.entries()][0][0];
  returned[0] = 9;
  expect(tree.has("0102")).toBe(true);
});
test("seeded B-tree edits match a sorted map including bounded iteration", () => {
  let x = 1234567,
    tree = BTreeMap.empty<number>();
  const expected = new Map<string, number>();
  const rand = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  for (let i = 0; i < 20000; i++) {
    const id = k(rand() % 2000);
    if (rand() % 3 === 0) {
      tree = tree.delete(id);
      expected.delete(id);
    } else {
      tree = tree.set(id, i);
      expected.set(id, i);
    }
    if (i % 211 === 0) {
      tree.validate();
      expect([...tree.entries()].map(([k, v]) => [hex(k), v])).toEqual(
        [...expected].sort(([a], [b]) => a.localeCompare(b)),
      );
      expect(
        [...tree.entries(k(500), k(800))].map(([k, v]) => [hex(k), v]),
      ).toEqual(
        [...expected]
          .filter(([id]) => id >= k(500) && id < k(800))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    }
  }
});
test("B-tree logical export is canonical and edits do not aggregate or store", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed });
  let calls = 0;
  const c = {
    ...plain,
    entry: () => {
      calls++;
      return null;
    },
  };
  let edit = BTreeEditor.from(
    b,
    Array.from({ length: 4000 }, (_, i) => [k(i), i] as [string, number]),
    c,
  );
  const old = edit;
  edit = edit.set(k(17), -1).delete(k(31)).set(k(4000), 4000);
  expect(calls).toBe(0);
  expect(storage.objects.size).toBe(0);
  expect(old.get(k(17))).toBe(17);
  const stored = await edit.store(),
    canonical = await BTree.build(b, [...edit.entries()].reverse(), c);
  expect(stored.root[6].sha384).toEqual(canonical.root[6].sha384);
  const loaded = await stored.edit();
  expect([...loaded.entries()]).toEqual([...edit.entries()]);
  expect(loaded.set(k(17), -1)).toBe(loaded);
});
test("B-tree deferred reads retain traversal, reject failures and validate cached descriptors", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed }),
    stored = await BTree.build(
      b,
      Array.from({ length: 10000 }, (_, i) => [k(i), i] as [string, number]),
      plain,
    );
  const reader = new BTree(new Basin(storage, { seed }), stored.root, plain);
  storage.reads = 0;
  const op = reader.getOrDefer(k(7777));
  expect(typeof op).toBe("function");
  expect(storage.reads).toBe(0);
  expect(await resolveOperation(op)).toBe(7777);
  const reads = storage.reads;
  expect(reader.getOrDefer(k(7777))).toBe(7777);
  expect(storage.reads).toBe(reads);
  const failing = new BTree(
    new Basin(
      {
        get: async () => {
          throw Error("offline");
        },
        put: storage.put.bind(storage),
      },
      { seed },
    ),
    stored.root,
    plain,
  );
  await expect(resolveOperation(failing.getOrDefer(k(7777)))).rejects.toThrow(
    "offline",
  );
  const headerChanged = [...stored.root] as Edge;
  headerChanged[5] = { ...(stored.root[5] as object), count: 1n };
  expect(() =>
    new BTree(reader.basin, headerChanged, plain).getOrDefer(k(7777)),
  ).toThrow();
  const corrupted = [...stored.root] as Edge;
  corrupted[3] = { ...stored.root[3] };
  corrupted[3].height++;
  const bad = new BTree(reader.basin, corrupted, plain);
  await expect(resolveOperation(bad.getOrDefer(k(7777)))).rejects.toThrow();
});
