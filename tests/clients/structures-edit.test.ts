import { test, expect } from "bun:test";
import { Basin, MemoryStorage, hex, type Edge } from "./structures/core";
import { Trie, TrieEditor, plain } from "./structures/trie";
import { Vector, VectorEditor } from "./structures/vector";
import { TrieMap } from "./structures/logical-trie";
import { VectorMap } from "./structures/logical-vector";
import { resolveOperation } from "./structures/operation";
const seed = new Uint8Array(32).fill(42);
const basin = () => new Basin(new MemoryStorage(), { seed });
function generator() {
  let n = 42;
  return () => (n = (Math.imul(n, 1664525) + 1013904223) >>> 0);
}

test("logical trie edits own keys, preserve snapshots and match a map through splits/collapses", () => {
  let tree = TrieMap.from<number | null>([]);
  const model = new Map<string, number | null>(),
    random = generator();
  const snapshots: {
    tree: TrieMap<number | null>;
    rows: [string, number | null][];
  }[] = [];
  for (let step = 0; step < 4000; step++) {
    const k = (random() % 2048).toString(16).padStart(4, "0");
    if (step % 7 === 0) {
      tree = tree.delete(k);
      model.delete(k);
    } else {
      const v = step % 5 ? step : null;
      const bytes = new Uint8Array([
        parseInt(k.slice(0, 2), 16),
        parseInt(k.slice(2), 16),
      ]);
      tree = tree.set(bytes, v);
      bytes.fill(255);
      model.set(k, v);
    }
    if (step % 400 === 0) snapshots.push({ tree, rows: [...model].sort() });
  }
  for (const snapshot of [...snapshots, { tree, rows: [...model].sort() }]) {
    expect([...snapshot.tree.entries()].map(([k, v]) => [hex(k), v])).toEqual(
      snapshot.rows,
    );
    for (const [k, v] of snapshot.rows) expect(snapshot.tree.get(k)).toBe(v);
  }
  const first = [...tree.entries()][0];
  first[0].fill(255);
  expect(tree.get([...model.keys()][0])).toBe(model.get([...model.keys()][0]));
  tree = tree.set("", 7).set("00", 8).set("000000", 9);
  expect(tree.get("")).toBe(7);
  expect(tree.get("00")).toBe(8);
  expect(tree.get("000000")).toBe(9);
  expect(tree.delete("ffff00")).toBe(tree);
  expect(tree.set("", 7)).toBe(tree);
  for (const [k] of [...tree.entries()]) tree = tree.delete(k);
  expect(tree.size).toBe(0);
  expect([...tree.entries()]).toEqual([]);
});

test("bitmap vector edits preserve holes, bit31 and snapshots through growth/shrink", () => {
  let tree = VectorMap.from<number | null | undefined>(0n, []);
  const model = new Map<bigint, number | null | undefined>(),
    random = generator();
  for (let step = 0; step < 2000; step++) {
    const length = BigInt(random() % 2050),
      old = tree;
    tree = tree.resize(length);
    for (const i of model.keys()) if (i >= length) model.delete(i);
    if (length) {
      const i = BigInt(random()) % length;
      if (step % 3 === 0) {
        tree = tree.delete(i);
        model.delete(i);
      } else {
        const v = step % 7 ? step : null;
        tree = tree.set(i, v);
        model.set(i, v);
      }
    }
    if (step % 100 === 0) {
      expect([...tree.entries()]).toEqual(
        [...model].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      expect(tree.size).toBe(model.size);
    }
    // Reading an earlier version must not depend on the later length/contents.
    expect([...old.entries()].every(([i]) => i < old.length)).toBe(true);
  }
  const wide = 1n << 200n;
  tree = tree
    .resize(wide + 33n)
    .set(31n, undefined)
    .set(wide + 31n, null)
    .set(wide + 32n, 5);
  expect(tree.has(31n)).toBe(true);
  expect(tree.get(31n)).toBeUndefined();
  expect(tree.has(32n)).toBe(model.has(32n));
  const saved = tree,
    next = tree.resize(32n);
  expect(next.has(wide + 31n)).toBe(false);
  expect(saved.get(wide + 32n)).toBe(5);
  expect(next.push(9).get(32n)).toBe(9);
  expect(next.push(9).pop().length).toBe(32n);
  expect(tree.delete(wide + 30n)).toBe(tree);
  expect(tree.set(wide + 32n, 5)).toBe(tree);
  expect(() => tree.set(-1n, 1)).toThrow();
  expect(() => tree.resize(-1n)).toThrow();
});

test("editors batch without storage or callbacks; export agrees with canonical rebuild", async () => {
  const b = basin(),
    storage = b.storage as MemoryStorage;
  let entries = 0;
  // Deliberately non-associative combine: export must retain flat-entry semantics.
  const c = {
    migration: 7,
    empty: "empty",
    entry: async (k: Uint8Array, v: number | null) => {
      entries++;
      return `${hex(k)}=${v}`;
    },
    combine: async (parts: readonly string[]) => `[${parts.join("|")}]`,
  };
  const rows = Array.from(
    { length: 1400 },
    (_, i) => [i.toString(16).padStart(4, "0"), i] as [string, number | null],
  );
  const t = await Trie.build(b, rows, c),
    v = await Vector.build(
      b,
      rows.map(([, v]) => v),
      c,
    );
  const te = await t.edit(),
    ve = await v.edit(),
    calls = entries,
    reads = storage.reads,
    objects = storage.objects.size;
  let tn = te,
    vn = ve;
  for (let i = 0; i < 100; i++) {
    tn = tn.set(i.toString(16).padStart(4, "0"), -i);
    vn = vn.set(BigInt(i), -i);
  }
  tn = tn.delete("0100").set("ffff", null);
  vn = vn.delete(256n).push(null).resize(2049n).set(2048n, 88);
  expect(entries).toBe(calls);
  expect(storage.reads).toBe(reads);
  expect(storage.objects.size).toBe(objects);
  expect(te.get("0001")).toBe(1);
  expect(ve.get(1n)).toBe(1);
  const ts = await tn.store(),
    vs = await vn.store();
  const tr = await Trie.build(b, tn.entries(), c),
    vr = await Vector.buildEntries(b, vn.length, vn.entries(), c);
  expect(ts.root[6].sha384).toEqual(tr.root[6].sha384);
  expect(vs.root[6].sha384).toEqual(vr.root[6].sha384);
  expect(await ts.get("ffff")).toBeNull();
  expect(await vs.get(2048n)).toBe(88);
  expect(await t.get("0001")).toBe(1);
  expect(await v.get(1n)).toBe(1);
  expect(await TrieEditor.from(b, [], plain).store()).toBeInstanceOf(Trie);
  expect((await VectorEditor.from(b, 0n, [], plain).store()).length).toBe(0n);
});

test("vector ready/deferred reads preserve integrity checks, failures, holes and high indices", async () => {
  class Flaky extends MemoryStorage {
    fail = false;
    override async get(e: Edge) {
      if (this.fail) throw Error("offline");
      return super.get(e);
    }
  }
  const storage = new Flaky(),
    b = new Basin(storage, { seed }),
    wide = 1n << 200n;
  const source = await Vector.buildEntries(
    b,
    wide + 33n,
    [
      [0n, 1],
      [31n, null],
      [wide + 31n, 9],
      [wide + 32n, 11],
    ],
    plain,
  );
  const reader = new Basin(storage, { seed }),
    v = new Vector(reader, source.root, plain);
  expect(typeof v.getOrDefer(wide + 31n)).toBe("function");
  expect(storage.reads).toBe(0);
  expect(await resolveOperation(v.getOrDefer(wide + 31n))).toBe(9);
  expect(v.getOrDefer(wide + 31n)).toBe(9);
  expect(await v.get(31n)).toBeNull();
  expect(await v.get(30n)).toBeUndefined();
  expect(await v.get(0n)).toBe(1);
  expect(await v.get(wide + 32n)).toBe(11);
  const h = source.root[5] as { count: bigint };
  h.count++;
  expect(() => v.getOrDefer(wide + 31n)).toThrow();
  h.count--;
  reader.clearCache();
  storage.fail = true;
  await expect(resolveOperation(v.getOrDefer(wide + 31n))).rejects.toThrow(
    "offline",
  );
  storage.fail = false;
  expect(await v.get(wide + 31n)).toBe(9);
});

test("vector digit lookups agree around safe-number and radix boundaries", async () => {
  const positions = new Set<bigint>();
  for (const bits of [0, 5, 10, 32, 52, 53, 54, 64, 127, 200, 255])
    for (const offset of [-1n, 0n, 1n, 30n, 31n, 32n]) {
      const i = (1n << BigInt(bits)) + offset;
      if (i >= 0n) positions.add(i);
    }
  const rows = [...positions].map((i, v) => [i, v] as [bigint, number]);
  const v = await Vector.buildEntries(basin(), 1n << 256n, rows, plain);
  for (let round = 0; round < 2; round++) {
    v.basin.clearCache();
    for (const [i, expected] of rows) expect(await v.get(i)).toBe(expected);
    for (const i of positions)
      if (!positions.has(i + 2n)) expect(await v.get(i + 2n)).toBeUndefined();
  }
});

test("logical builders reject duplicates and excessive depth", () => {
  expect(() =>
    TrieMap.from([
      ["00", 1],
      ["00", 2],
    ]),
  ).toThrow();
  expect(() =>
    VectorMap.from(1n, [
      [0n, 1],
      [0n, 2],
    ]),
  ).toThrow();
  expect(() => VectorMap.from(1n, [[1n, 1]])).toThrow();
  expect(() => VectorMap.from(1n << 1281n, [])).toThrow("nesting");
  const keys = Array.from(
    { length: 600 },
    (_, i) => ["00".repeat(i) + "01", i] as const,
  );
  expect(() => TrieMap.from(keys)).toThrow("nesting");
  let t = TrieMap.from<number>([]),
    rejected = false;
  for (const [k, v] of keys) {
    try {
      t = t.set(k, v);
    } catch (e) {
      expect((e as Error).message).toContain("nesting");
      rejected = true;
      break;
    }
  }
  expect(rejected).toBe(true);
});

test("logical edits carry offsets through long prefixes, splits and prefix keys", () => {
  const prefix = "ab".repeat(60);
  const rows = Array.from(
    { length: 1800 },
    (_, i) => [prefix + i.toString(16).padStart(4, "0"), i] as const,
  );
  const t = TrieMap.from(rows);
  let n = t.set(prefix, -1).set(prefix.slice(0, -2), -2).set("ac", -3);
  for (let i = 0; i < rows.length; i++) {
    expect(n.get(rows[i][0])).toBe(i);
    n = i % 3 ? n.set(rows[i][0], -i) : n.delete(rows[i][0]);
  }
  for (let i = 0; i < rows.length; i++) {
    expect(n.get(rows[i][0])).toBe(i % 3 ? -i : undefined);
    expect(t.get(rows[i][0])).toBe(i);
  }
  expect(n.get(prefix)).toBe(-1);
  expect(n.get(prefix.slice(0, -2))).toBe(-2);
  expect(n.get("ac")).toBe(-3);
});
