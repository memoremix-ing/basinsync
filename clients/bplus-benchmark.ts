/** Stored-client comparison: CPU and request/byte counts; no server/timeline work. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  Basin,
  MemoryStorage,
  type Edge,
  type Storage,
} from "./structures/core";
import { BTree } from "./structures/btree";
import { BPlusTree, type BPlusOptions } from "./structures/bplus";
import { plain } from "./structures/trie";
const seed = new Uint8Array(32).fill(42),
  key = (i: number) =>
    new Uint8Array([i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]);
const variants: [string, BPlusOptions | undefined][] = [
  ["btree", undefined],
  [
    "plus-31x32",
    { leafKeys: 31, branchChildren: 32, leafInline: 1280, branchInline: 1280 },
  ],
  [
    "plus-31x32-routing8192",
    { leafKeys: 31, branchChildren: 32, leafInline: 1280, branchInline: 8192 },
  ],
  [
    "plus-31x128-routing1280",
    { leafKeys: 31, branchChildren: 128, leafInline: 1280, branchInline: 1280 },
  ],
  [
    "plus-31x128",
    { leafKeys: 31, branchChildren: 128, leafInline: 1280, branchInline: 8192 },
  ],
  [
    "plus-127x128",
    {
      leafKeys: 127,
      branchChildren: 128,
      leafInline: 1280,
      branchInline: 8192,
    },
  ],
  [
    "plus-255x128",
    {
      leafKeys: 255,
      branchChildren: 128,
      leafInline: 1280,
      branchInline: 8192,
    },
  ],
  [
    "plus-1023x128",
    {
      leafKeys: 1023,
      branchChildren: 128,
      leafInline: 1280,
      branchInline: 8192,
    },
  ],
  [
    "plus-31x128-inline4096",
    { leafKeys: 31, branchChildren: 128, leafInline: 4096, branchInline: 8192 },
  ],
];
const samples: any[] = [];
for (const scenario of [
  { n: 20000, payload: 0 },
  { n: 100000, payload: 0 },
  { n: 5000, payload: 4096 },
]) {
  const { n, payload } = scenario,
    keys = Array.from({ length: n }, (_, i) => key(i)),
    rows = keys.map(
      (k, i) =>
        [k, payload ? new Uint8Array(payload).fill(i & 255) : i] as [
          Uint8Array,
          number | Uint8Array,
        ],
    );
  for (let trial = 0; trial < (payload ? 1 : 3); trial++)
    for (const [name, options] of trial % 2
      ? variants.toReversed()
      : variants) {
      const storage = new MemoryStorage(),
        writer = new Basin(storage, { seed, cacheBytes: 256 * 1024 * 1024 }),
        start = performance.now();
      const tree = options
          ? await BPlusTree.build(writer, rows, plain, options)
          : await BTree.build(writer, rows, plain),
        buildMs = performance.now() - start;
      let gets = 0,
        bytes = 0,
        resolves = 0;
      const adapter: Storage = {
        put: storage.put.bind(storage),
        get: async (e) => {
          gets++;
          const b = await storage.get(e);
          bytes += b.length;
          return b;
        },
        resolve: async (l) => {
          resolves++;
          return storage.resolve(l);
        },
      };
      const open = () =>
        options
          ? new BPlusTree(
              new Basin(adapter, { seed, cacheBytes: 256 * 1024 * 1024 }),
              tree.root,
              plain,
            )
          : new BTree(
              new Basin(adapter, { seed, cacheBytes: 256 * 1024 * 1024 }),
              tree.root,
              plain,
            );
      const probes = [];
      for (const at of [0, Math.floor(n / 2), n - 1])
        for (const hints of options ? [false, true] : [false]) {
          gets = bytes = resolves = 0;
          const reader = open(),
            v = options
              ? await (reader as BPlusTree).get(keys[at], { shortcuts: hints })
              : await reader.get(keys[at]);
          if (payload) assert.deepEqual(v, rows[at][1]);
          else assert.equal(v, at);
          probes.push({ at, hints, gets, bytes, resolves });
        }
      let randomGets = 0,
        randomBytes = 0;
      for (let i = 1; i <= 32; i++) {
        gets = bytes = 0;
        const at = (i * 7919) % n;
        const value = await open().get(keys[at]);
        if (!payload) assert.equal(value, at);
        else assert.deepEqual(value, rows[at][1]);
        randomGets += gets;
        randomBytes += bytes;
      }
      let hotMs: number | undefined;
      if (!payload) {
        const reader = open(),
          query = Array.from({ length: 64 }, (_, i) => (i * 7919) % n);
        for (const i of query) assert.equal(await reader.get(keys[i]), i);
        gets = bytes = 0;
        const at = performance.now();
        let sum = 0;
        for (let i = 0; i < 100000; i++)
          sum += (await reader.get(keys[query[i % 64]])) as number;
        hotMs = performance.now() - at;
        assert(sum > 0);
        assert.equal(gets, 0, "hot working set exceeded cache");
      }
      samples.push({
        trial,
        name,
        n,
        payload,
        options,
        buildMs,
        randomGets: randomGets / 32,
        randomBytes: randomBytes / 32,
        hotMs,
        objects: storage.objects.size,
        storedBytes: [...storage.objects.values()].reduce(
          (n, o) => n + o.bytes.length,
          0,
        ),
        height: tree.root[3].height,
        probes,
      });
    }
}
const result = {
  runtime: Bun.version,
  method:
    "3 alternating trials for compact values, one transfer trace for 4096-byte values; memory storage; build includes crypto; 100k warm owned-value reads over 64 keys, zero GETs verified; cold probes new cache; hint resolver has no network I/O",
  samples,
};
writeFileSync(
  Bun.env.BPLUS_OUT ?? ".local/bplus-benchmark.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log("B+tree comparison complete");
