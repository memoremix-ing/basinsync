import { test, expect } from "bun:test";
import { Basin, MemoryStorage, hex, type Edge } from "./structures/core";
import { resolveOperation } from "./structures/operation";
import { Trie, plain } from "./structures/trie";
const seed = new Uint8Array(32).fill(42);
test("opportunistic trie reads defer I/O, preserve keys, and share pending loads", async () => {
  const storage = new MemoryStorage(),
    writer = new Basin(storage, { seed });
  const rows: [Uint8Array, number][] = Array.from({ length: 6000 }, (_, i) => [
    new Uint8Array([i >> 8, i & 255]),
    i,
  ]);
  const source = await Trie.build(writer, rows, plain),
    reader = new Basin(storage, { seed }),
    trie = new Trie(reader, source.root, plain);
  const key = rows[5000][0].slice(),
    operation = trie.getOrDefer(key);
  expect(typeof operation).toBe("function");
  expect(storage.reads).toBe(0);
  key.fill(255);
  const [a, b] = await Promise.all([
    resolveOperation(operation),
    resolveOperation(trie.getOrDefer(rows[5000][0])),
  ]);
  expect(a).toBe(5000);
  expect(b).toBe(5000);
  expect(storage.reads).toBeLessThanOrEqual(2);
  expect(trie.getOrDefer(rows[5000][0])).toBe(5000);
  expect(trie.getViewOrDefer(rows[5000][0])).not.toBeInstanceOf(Function);
  reader.clearCache();
  expect(typeof trie.getOrDefer(rows[5000][0])).toBe("function");
  expect(await trie.get(rows[5000][0])).toBe(5000);
  const h = source.root[5] as { count: bigint };
  const prior = h.count;
  h.count++;
  expect(() => trie.getOrDefer(rows[5000][0])).toThrow();
  h.count = prior;
  expect(trie.getOrDefer(rows[5000][0])).toBe(5000);
});
test("deferred load failures propagate, evict failures, and remain retryable", async () => {
  class Flaky extends MemoryStorage {
    failing = true;
    override async get(edge: Edge) {
      if (this.failing) throw Error("offline");
      return super.get(edge);
    }
  }
  const storage = new Flaky(),
    built = await Trie.build(
      new Basin(storage, { seed }),
      [["ab", null]],
      plain,
    );
  const trie = new Trie(new Basin(storage), built.root, plain);
  await expect(resolveOperation(trie.getOrDefer("ab"))).rejects.toThrow(
    "offline",
  );
  storage.failing = false;
  expect(await resolveOperation(trie.getOrDefer("ab"))).toBeNull();
  expect(trie.getOrDefer("ac")).toBeUndefined();
});
test("operation runner delivers rejection to generator catch and finally", async () => {
  let finalized = 0;
  const op = function* () {
    try {
      yield Promise.reject(Error("expected"));
      return "wrong";
    } catch (e) {
      return (e as Error).message;
    } finally {
      finalized++;
    }
  };
  expect(await resolveOperation(op)).toBe("expected");
  expect(finalized).toBe(1);
  expect(await resolveOperation(42)).toBe(42);
  await expect(
    resolveOperation(function* () {
      yield Promise.resolve(1);
      throw Error("after resume");
    }),
  ).rejects.toThrow("after resume");
});

test("cache checks descriptor lengths and native hex ignores instance overrides", async () => {
  const bytes = new Uint8Array([0, 1, 255]);
  Object.defineProperty(bytes, "toHex", { value: () => "wrong" });
  expect(hex(bytes)).toBe("0001ff");
  const basin = new Basin(new MemoryStorage(), { seed }),
    trie = await Trie.build(basin, [["ab", 42]], plain);
  await basin.load(trie.root);
  const wrong = [...trie.root] as Edge;
  wrong[6] = { ...trie.root[6], length: trie.root[6].length + 8 };
  expect(() => basin.peek(wrong)).toThrow();
  await expect(basin.load(wrong)).rejects.toThrow();
});
test("synchronous and asynchronous consumer aggregation produce identical bytes", async () => {
  const rows: [Uint8Array, number][] = Array.from({ length: 1600 }, (_, i) => [
    new Uint8Array([i >> 8, i & 255]),
    i,
  ]);
  const sync = {
    migration: 7,
    empty: 0n,
    entry: () => 1n,
    combine: (a: readonly bigint[]) => a.reduce((s, v) => s + v, 0n),
  };
  const asynchronous = {
    ...sync,
    entry: async () => 1n,
    combine: async (a: readonly bigint[]) => sync.combine(a),
  };
  const a = await Trie.build(
    new Basin(new MemoryStorage(), { seed }),
    rows,
    sync,
  );
  const b = await Trie.build(
    new Basin(new MemoryStorage(), { seed }),
    rows,
    asynchronous,
  );
  expect(a.root[6].sha384).toEqual(b.root[6].sha384);
  expect(await b.get(rows[1599][0])).toBe(1599);
});

test("offset reads preserve long prefixes across uncached node boundaries", async () => {
  const { utf8 } = await import("./structures/core");
  const rows: [Uint8Array, unknown][] = [];
  for (let group = 0; group < 4; group++)
    for (let i = 0; i < 2048; i++)
      rows.push([
        utf8(`root/${group}-shared/${i.toString(16).padStart(4, "0")}`),
        i % 7 ? { n: BigInt(i), data: new Uint8Array([i & 255]) } : null,
      ]);
  const storage = new MemoryStorage();
  const built = await Trie.build(new Basin(storage, { seed }), rows, plain);
  const cold = new Trie(
    new Basin(storage, { cacheBytes: 0 }),
    built.root,
    plain,
  );
  for (const index of [0, 1, 254, 255, 256, 2047, 2048, rows.length - 1]) {
    const key = rows[index][0].slice(),
      op = cold.getOrDefer(key);
    expect(typeof op).toBe("function");
    key.fill(255);
    expect(await resolveOperation(op)).toEqual(rows[index][1]);
    const view = await cold.getView(rows[index][0]);
    expect(view).toBeDefined();
  }
  for (const missing of [
    "root/1",
    "root/1-shared",
    "root/1-shared/",
    "root/1-shared/00",
    "root/1-shared/0800",
    "root/1-shared/0000x",
  ])
    expect(await cold.get(utf8(missing))).toBeUndefined();
});

test("browser bundles load the public structures without filesystem access", async () => {
  // Regression: the shared object-key fixture previously read node:fs at import time.
  const result = await Bun.build({
    entrypoints: [new URL("./structures/index.ts", import.meta.url).pathname],
    target: "browser", minify: true,
  });
  expect(result.success).toBe(true);
  const source = await result.outputs[0].text();
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const basin = new api.Basin(new api.MemoryStorage());
  const trie = await api.Trie.build(basin, [["ab", new Uint8Array([1, 2])]], api.plain);
  expect(await trie.get("ab")).toEqual(new Uint8Array([1, 2]));
});
