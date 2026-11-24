import { test, expect } from "bun:test";
import {
  Basin,
  MemoryStorage,
  concat,
  equal,
  compare,
  utf8,
  hex,
  nodeBytes,
  object,
  query,
  derive,
  sha384,
  capability,
  link,
  nodeKey,
  Node,
  type Edge,
} from "./structures/core";
import { Trie, plain, Consumer } from "./structures/trie";
import { Volume, PAGE_SIZE } from "./structures/volume";
import * as sl2 from "./structures/bromberg";
const seed = new Uint8Array(32).fill(42);
const entries = (n: number): [Uint8Array, unknown][] =>
  Array.from({ length: n }, (_, i) => [
    new Uint8Array([i >> 8, i & 255]),
    i % 7 === 0 ? null : { n: BigInt(i), data: new Uint8Array([i & 255]) },
  ]);
const sum: Consumer<unknown, bigint> = {
  migration: 7,
  empty: 0n,
  entry: () => 1n,
  combine: (parts) => parts.reduce((a, b) => a + b, 0n),
};
test("SL2 independent published vector and concatenation", () => {
  const text = "hello, world! It's fun to hash stuff!";
  expect(hex(sl2.hash(utf8(text)))).toBe(
    "01c5cf590d32654c87228c0d66441b200aec1439e54e724f05cd3c6c260634e565594b61988933e826e9705de22884ce007df0f733a371516ddd4ac9237f7a46",
  );
  expect(
    sl2.combine([sl2.hash(utf8("hello, ")), sl2.hash(utf8("world!"))]),
  ).toEqual(sl2.hash(utf8("hello, world!")));
});
test("canonical groups, suffixes, edge boundaries, empty keys and null values", async () => {
  for (const count of [0, 1, 63, 64, 255, 256, 1280, 1281, 5000]) {
    const storage = new MemoryStorage(),
      basin = new Basin(storage, { seed }),
      data = entries(count),
      a = await Trie.build(basin, data, sum),
      b = await Trie.build(basin, data.toReversed(), sum);
    expect(Object.hasOwn(a.root[5] as object, "reversals")).toBe(false);
    expect(a.root[6].sha384).toEqual(b.root[6].sha384);
    expect(a.root[6][1]).toBe(BigInt(count));
    const loaded = new Trie(new Basin(storage, { seed }), a.root, sum);
    for (const i of [0, 1, 62, 63, 254, 255, 1279, count - 1].filter(
      (i) => i >= 0 && i < count,
    ))
      expect(await loaded.get(data[i][0])).toEqual(data[i][1]);
    expect(await loaded.get("ffffff")).toBeUndefined();
    let seen = 0;
    for await (const row of loaded.entries()) expect(row).toEqual(data[seen++]);
    expect(seen).toBe(count);
  }
  const basin = new Basin(new MemoryStorage(), { seed }),
    t = await Trie.build(
      basin,
      [
        ["", null],
        ["ab", 1n],
        ["abcd", 2n],
      ],
      sum,
    );
  expect(await t.get("")).toBeNull();
  expect(await t.get("ab")).toBe(1n);
  expect(await t.get("abcd")).toBe(2n);
  const collapsed = await t.update([
      ["abcd", { delete: true }],
      ["ab", { delete: true }],
      ["", { delete: true }],
    ]),
    empty = await Trie.build(basin, [], sum);
  expect(collapsed.root[6].sha384).toEqual(empty.root[6].sha384);
}, 30000);
test("deterministic deletion, lazy pruning, callback summaries and corrupt descriptors", async () => {
  const storage = new MemoryStorage(),
    basin = new Basin(storage, { seed }),
    data = entries(2000),
    t = await Trie.build(basin, data, sum),
    other = await t.update([[data.at(-1)![0], { delete: true }]]),
    fresh = await Trie.build(basin, data.slice(0, -1), sum);
  expect(other.root[6].sha384).toEqual(fresh.root[6].sha384);
  const reader = new Trie(new Basin(storage, { seed }), t.root, sum);
  storage.reads = 0;
  let found = 0;
  for await (const _ of reader.entries("", () => false)) found++;
  expect(found).toBe(0);
  expect(storage.reads).toBe(0);
  expect(await reader.get(data[1000][0])).toEqual(data[1000][1]);
  expect(storage.reads).toBeLessThanOrEqual(2);
  const bad = [...t.root] as typeof t.root;
  bad[5] = { ...(bad[5] as object), count: 1n };
  await expect(new Basin(storage, { seed }).load(bad)).rejects.toThrow(
    "summary mismatch",
  );
  const item = storage.objects.get(capability(link(t.root)))!;
  item.bytes = item.bytes.slice();
  item.bytes[8] ^= 1;
  await expect(new Basin(storage, { seed }).load(t.root)).rejects.toThrow(
    "digest",
  );
}, 30000);
test("breadth counts shared nested paths; capacities, versions and entropy are checked", async () => {
  const basin = new Basin(new MemoryStorage(), { seed }),
    leaf = await Trie.build(basin, [["", 1]], plain),
    left = await basin.seal(
      {
        0: Symbol.species,
        1: "sync.memoremix.com",
        2: "left",
        3: query([]),
        4: 0,
        5: null,
        6: [0, null],
      } as Node,
      [leaf.root],
    ),
    right = await basin.seal(
      {
        0: Symbol.species,
        1: "sync.memoremix.com",
        2: "right",
        3: query([]),
        4: 0,
        5: null,
        6: [0, null],
      } as Node,
      [leaf.root],
    );
  const q = query([left, right]);
  expect(q.degree).toBe(2);
  expect(q.breadth).toBe(4n);
  expect(q.height).toBe(2);
  const k = await derive(leaf.root);
  expect(k.token.length).toBe(32);
  expect(k.secret).not.toEqual(k.token);
  expect(k.nonce.length).toBe(12);
  await expect(Trie.build(basin, [["0", 1]], plain)).rejects.toThrow(
    "even-length",
  );
  await expect(
    Trie.build(
      basin,
      [
        ["ab", 1],
        ["AB", 2],
      ],
      plain,
    ),
  ).rejects.toThrow("duplicate");
});
test("volume retention, basename hashes, UTF-8 maps, empty/multipage files, snapshot updates and shortcut misses", async () => {
  const storage = new MemoryStorage(),
    basin = new Basin(storage, { seed }),
    large = Uint8Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) => i & 255),
    files: [string, Uint8Array][] = [
      ["/a", large],
      ["/dir/empty", new Uint8Array()],
      ["/dir/__proto__", utf8("safe")],
      ["/\uffff", utf8("bmp")],
      ["/\u{10000}", utf8("astral")],
    ],
    v = await Volume.build(basin, files),
    loaded = new Volume(new Basin(storage, { seed }), v.root);
  for (const [name, data] of files) {
    expect(await loaded.read(name)).toEqual(data);
    expect(await loaded.read(name, { shortcuts: false })).toEqual(data);
  }
  expect(await loaded.read("/a", { start: 4090, length: 16 })).toEqual(
    large.slice(4090, 4106),
  );
  expect(await loaded.list("/dir")).toEqual(["__proto__", "empty"]);
  storage.capabilities.clear();
  expect(
    await new Volume(new Basin(storage, { seed }), v.root).read("/a"),
  ).toEqual(large);
  const updated = await v.update([
    ["/a", null],
    ["/b", large],
  ]);
  expect(updated.root[6].sha384).not.toEqual(v.root[6].sha384);
  expect(await v.read("/a")).toEqual(large);
  expect(await updated.read("/b")).toEqual(large);
  await expect(updated.read("/a")).rejects.toThrow("missing");
  await expect(
    Volume.build(basin, [
      ["/a", new Uint8Array()],
      ["/a/b", new Uint8Array()],
    ]),
  ).rejects.toThrow("collision");
}, 30000);
test("range reads use page boundary spines and avoid unrelated sector objects", async () => {
  const storage = new MemoryStorage(),
    basin = new Basin(storage, { seed }),
    data = Uint8Array.from(
      { length: PAGE_SIZE * 1281 + 13 },
      (_, i) => i & 255,
    ),
    v = await Volume.build(basin, [["/large", data]]);
  let transferred = 0,
    resolutions = 0;
  const get = storage.get.bind(storage),
    resolve = storage.resolve.bind(storage);
  storage.get = async (e) => {
    const b = await get(e);
    transferred += b.length;
    return b;
  };
  storage.resolve = async (l) => {
    resolutions++;
    return resolve(l);
  };
  storage.reads = 0;
  const reader = new Volume(new Basin(storage, { seed }), v.root);
  expect(await reader.read("/large", { start: 3, length: 17 })).toEqual(
    data.slice(3, 20),
  );
  expect(transferred).toBeLessThan(data.length / 4);
  expect(resolutions).toBeGreaterThanOrEqual(1);
  expect(storage.reads).toBeLessThanOrEqual(3);
  expect(
    await reader.read("/large", { start: data.length - 5, length: 40 }),
  ).toEqual(data.slice(-5));
  expect(
    await reader.read("/large", { start: data.length + 10, length: 4 }),
  ).toEqual(new Uint8Array());
  storage.capabilities.clear();
  expect(
    await new Volume(new Basin(storage, { seed }), v.root).read("/large", {
      start: 3,
      length: 17,
    }),
  ).toEqual(data.slice(3, 20));
}, 60000);
test("consumer migration rebuilds preserve old snapshots and reject unknown versions", async () => {
  const basin = new Basin(new MemoryStorage(), { seed }),
    old = await Trie.build(basin, entries(1400), sum),
    rows: [Uint8Array, { old: unknown }][] = [];
  for await (const [k, v] of old.entries()) rows.push([k, { old: v }]);
  const next = await Trie.build(basin, rows, { ...sum, migration: 8 });
  expect(next.root[4]).toBe(0);
  expect(next.root[6].version).toBe(0);
  expect(next.root[6][0]).toBe(8);
  expect(await old.get("0001")).toEqual(entries(2)[1][1]);
  expect(await next.get("0001")).toEqual({ old: entries(2)[1][1] });
  expect(() => new Trie(basin, next.root, sum)).toThrow("migration");
});
test("empty directories survive canonical file updates", async () => {
  const b = new Basin(new MemoryStorage(), { seed }),
    v = await Volume.build(
      b,
      [["/kept/file", utf8("x")]],
      ["/empty", "/deep/empty"],
    );
  expect(await v.list("/empty")).toEqual([]);
  expect(await (await v.update([["/kept/file", null]])).list("/kept")).toEqual(
    [],
  );
});

test("allocation revisions pin strong edges, shortcuts, storage identities and object addresses", async () => {
  const storage = new MemoryStorage(),
    basin = new Basin(storage, { seed });
  const first = await Trie.build(basin, [["ab", 1n]], plain);
  expect(first.root[6].revision).toMatch(/-4[0-9a-f]{3}-[89ab]/);
  expect(link(first.root).revision).toBe(first.root[6].revision);
  const token = (await derive(first.root)).token;
  expect(await nodeKey(link(first.root), "old")).toBe(
    `userspace/heap/old/n-0yvf/v.0zg0/t.0zh20/d_${hex(await sha384(token))}/${first.root[6].revision}`,
  );
  storage.objects.delete(capability(link(first.root)));
  const second = await Trie.build(basin, [["ab", 1n]], plain);
  expect(second.root[6].sha384).toEqual(first.root[6].sha384);
  expect(second.root[6].revision).not.toBe(first.root[6].revision);
  await expect(new Basin(storage).load(first.root)).rejects.toThrow("missing");
  expect(await new Trie(new Basin(storage), second.root, plain).get("ab")).toBe(
    1n,
  );
  expect(() => query([first.root, second.root])).toThrow("conflicting");
  const invalid = [...second.root] as typeof second.root;
  invalid[6] = { ...second.root[6], revision: "not-a-revision" };
  await expect(new Basin(storage).load(invalid)).rejects.toThrow("revision");
});

test("borrowed metadata validation checks nested values after cache hits", async () => {
  const summary = {
    values: [
      null,
      true,
      1,
      1.5,
      0n,
      2n ** 200n,
      "0literal",
      Symbol.match,
      Symbol.for("shared"),
      new Uint8Array([1, 2]),
    ],
    map: { ["__proto__"]: "safe", empty: [] },
  };
  const b = new Basin(new MemoryStorage(), { seed });
  const e = await b.seal(
    {
      0: Symbol.species,
      1: "sync.memoremix.com",
      2: "metadata",
      3: query([]),
      4: 0,
      5: summary,
      6: [7, summary],
    } as Node,
    [],
  );
  await b.load(e);
  await b.load(e);
  const mutations = [
    { ...summary, values: [...summary.values, 3] },
    {
      ...summary,
      values: summary.values.map((x, i) =>
        i === 9 ? new Uint8Array([1, 3]) : x,
      ),
    },
    { ...summary, map: { ["__proto__"]: "changed", empty: [] } },
    { ...summary, extra: true },
    null,
  ];
  for (const wrong of mutations) {
    const bad = [...e] as typeof e;
    bad[6] = { ...e[6], 1: wrong };
    await expect(b.load(bad)).rejects.toThrow("summary");
  }
  await b.load(e);
});

test("consumers can summarize reversed-key bounds in footers", async () => {
  type Bounds = [Uint8Array, Uint8Array] | null;
  const consumer: Consumer<number, Bounds> = {
    migration: 9,
    empty: null,
    entry: (key) => {
      const reversed = key.slice().reverse();
      return [reversed, reversed];
    },
    combine: (summaries) => {
      const all = summaries.flatMap((b) => b ?? []).sort(compare);
      return all.length ? [all[0], all.at(-1)!] : null;
    },
  };
  const input: [Uint8Array, number][] = Array.from({ length: 1500 }, (_, i) => [
    new Uint8Array([i >> 8, i & 255]),
    i,
  ]);
  const trie = await Trie.build(
    new Basin(new MemoryStorage(), { seed }),
    input,
    consumer,
  );
  expect(Object.hasOwn(trie.root[5] as object, "reversals")).toBe(false);
  expect((trie.root[6][1] as Bounds)?.map(hex)).toEqual(["0000", "ff04"]);
  expect(await trie.get(input[1499][0])).toBe(1499);
});

test("readers reject a 256-entry unsplit group", async () => {
  const basin = new Basin(new MemoryStorage(), { seed });
  const trie = await Trie.build(
    basin,
    Array.from(
      { length: 255 },
      (_, i) => [new Uint8Array([i]), i] as [Uint8Array, number],
    ),
    plain,
  );
  const node = object<Node>(await basin.load(trie.root));
  const group = node[6][2] as { keys: Uint8Array[]; values: number[] };
  group.keys.push(new Uint8Array([255]));
  group.values.push(255);
  const bad = new Trie(basin, await basin.seal(node, []), plain);
  await expect(bad.get("00")).rejects.toThrow("group");
});

test("stable buckets preserve canonical value-edge packing", async () => {
  const storage = new MemoryStorage(),
    basin = new Basin(storage, { seed });
  const leaves: Edge[] = [];
  for (let i = 0; i < 512; i++)
    leaves.push((await Trie.build(basin, [["", i]], plain)).root);
  const input: [Uint8Array, number][] = Array.from({ length: 512 }, (_, i) => [
    new Uint8Array([i & 255, i >> 8]),
    i,
  ]);
  const consumer: Consumer<number, null> = {
    ...plain,
    edges: (value) => [leaves[value]],
  };
  const a = await Trie.build(basin, input, consumer),
    count = storage.objects.size;
  const b = await Trie.build(basin, input.toReversed(), consumer);
  expect(a.root[6].sha384).toEqual(b.root[6].sha384);
  expect(storage.objects.size).toBe(count);
  expect(a.root[3].height).toBe(2);
  for (const node of storage.objects.values())
    expect(node.edges.length).toBeLessThanOrEqual(320);
  for (const i of [0, 1, 254, 255, 256, 511])
    expect(await b.get(input[i][0])).toBe(i);
});
