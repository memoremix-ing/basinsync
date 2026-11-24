/** Current volume layout: strong directory edges, page-trie boundary shortcuts. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  Basin,
  MemoryStorage,
  type Storage,
  object,
  type Node,
} from "./structures/core";
import { Volume, buildBlock } from "./structures/volume";
const seed = new Uint8Array(32).fill(42),
  samples: any[] = [];
for (const { maxDegree, firstPage } of [
  { maxDegree: 32, firstPage: 0 },
  { maxDegree: 320, firstPage: 0 },
  { maxDegree: 32, firstPage: 65536 },
  { maxDegree: 320, firstPage: 65536 },
]) {
  const n = 50000,
    storage = new MemoryStorage(),
    b = new Basin(storage, { seed, maxDegree }),
    pages = Array.from(
      { length: n },
      (_, i) =>
        [
          BigInt(i + firstPage),
          new Uint8Array([
            i >>> 24,
            (i >>> 16) & 255,
            (i >>> 8) & 255,
            i & 255,
          ]),
        ] as [bigint, Uint8Array],
    );
  const block = await buildBlock(b, pages),
    volume = await Volume.fromBlocks(b, [["/file", block]]);
  const body = object<Node>(await b.load(block.edge));
  for (const page of [0, 1, 15, Math.floor(n / 2), n - 16, n - 1])
    for (const shortcuts of [false, true]) {
      let gets = 0,
        bytes = 0,
        resolves = 0;
      const adapter: Storage = {
        put: storage.put.bind(storage),
        get: async (e) => {
          const data = await storage.get(e);
          gets++;
          bytes += data.length;
          return data;
        },
        resolve: async (l) => {
          resolves++;
          return storage.resolve(l);
        },
      };
      const reader = new Volume(
        new Basin(adapter, { seed, maxDegree }),
        volume.root,
      );
      assert.deepEqual(
        await reader.page("/file", BigInt(page + firstPage), shortcuts),
        pages[page][1],
      );
      const cold = { gets, bytes, resolves };
      assert.deepEqual(
        await reader.page("/file", BigInt(page + firstPage), shortcuts),
        pages[page][1],
      );
      samples.push({
        maxDegree,
        firstPage,
        n,
        page,
        shortcuts,
        ...cold,
        warmGets: gets - cold.gets,
        blockHeight: block.edge[3].height,
        leading: (body[6][3] as unknown[]).filter(Boolean).length,
        lagging: (body[6][4] as unknown[]).filter(Boolean).length,
      });
    }
}
writeFileSync(
  ".local/page-spines.json",
  JSON.stringify(
    {
      runtime: Bun.version,
      method:
        "50k unique four-byte pages; memory storage; cold whole-volume point reads; common metadata included; zero-I/O hint resolver; maxDegree 32 exercises deeper packing, 320 is default; shifted sparse keys expose boundary paths not already inline",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log("page spine measurements complete");
