import assert from "node:assert/strict";
import {
  Basin,
  MemoryStorage,
  key,
  type Edge,
} from "./structures/core";
import { Trie, type Consumer } from "./structures/trie";
const input = JSON.parse(await Bun.stdin.text());
const rows: [Uint8Array, number][] = input.entries.map(
  ([k, v]: [string, number]) => [key(k), v],
);
const queries: number[] = input.queries,
  hot = queries.slice(0, 64),
  prefix = key(input.prefix);
const c: Consumer<number, bigint> = {
  migration: 7,
  empty: 0n,
  entry: () => 1n,
  combine: (s) => s.reduce((n, v) => n + v, 0n),
};
class Store extends MemoryStorage {
  bytes = 0;
  override async get(e: Edge) {
    const b = await super.get(e);
    this.bytes += b.length;
    return b;
  }
}
const storage = new Store(),
  basin = new Basin(storage, { seed: new Uint8Array(32).fill(42) });
const samples: Record<string, number> = {};
async function phase(name: string, fn: () => Promise<void>) {
  const r = storage.reads,
    b = storage.bytes,
    start = performance.now();
  await fn();
  samples[`${name}_ms`] = performance.now() - start;
  samples[`${name}_reads`] = storage.reads - r;
  samples[`${name}_bytes`] = storage.bytes - b;
}
// Exercise the same code paths before timing, without warming the measured store.
const warm = await Trie.build(
  new Basin(new MemoryStorage(), { seed: new Uint8Array(32).fill(42) }),
  rows.slice(0, 256),
  c,
);
for (let i = 0; i < 256; i++)
  assert.equal(
    await warm.get(rows[i % Math.min(256, rows.length)][0]),
    rows[i % Math.min(256, rows.length)][1],
  );
let trie!: Trie<number, bigint>;
await phase("build", async () => {
  trie = await Trie.build(basin, rows, c);
});
const objects = storage.objects.size,
  stored_bytes = [...storage.objects.values()].reduce(
    (s, v) => s + v.bytes.length,
    0,
  ),
  height = trie.root[3].height;
for (const i of hot) assert.equal(await trie.get(rows[i][0]), rows[i][1]);
await phase("hot", async () => {
  for (let j = 0; j < input.hot; j++) {
    const i = hot[j % hot.length];
    assert.equal(await trie.get(rows[i][0]), rows[i][1]);
  }
});
await phase("mixed", async () => {
  for (const i of queries) assert.equal(await trie.get(rows[i][0]), rows[i][1]);
});
await phase("miss", async () => {
  for (const i of queries) {
    const k = new Uint8Array(rows[i][0].length + 1);
    k.set(rows[i][0]);
    k[k.length - 1] = 255;
    assert.equal(await trie.get(k), undefined);
  }
});
await phase("cold", async () => {
  for (const i of queries.slice(0, input.cold)) {
    basin.clearCache();
    assert.equal(await trie.get(rows[i][0]), rows[i][1]);
  }
});
await phase("scan", async () => {
  let count = 0,
    sum = 0;
  for await (const [, v] of trie.entries()) {
    count++;
    sum += v;
  }
  assert.equal(count, rows.length);
  assert.equal(sum, (rows.length * (rows.length - 1)) / 2);
});
let prefix_count = 0;
await phase("prefix", async () => {
  for await (const _ of trie.entries(prefix)) prefix_count++;
  assert.equal(prefix_count, input.prefix_count);
});
await phase("pruned", async () => {
  for (let i = 0; i < 1000; i++)
    for await (const _ of trie.entries(prefix, () => false))
      throw Error("unpruned");
});
for (const size of [1, 100])
  await phase(`update${size}`, async () => {
    const changes = queries
      .slice(0, size)
      .map(
        (i) =>
          [rows[i][0], { set: rows[i][1] + rows.length }] as [
            Uint8Array,
            { set: number },
          ],
      );
    const next = await trie.update(changes);
    assert.equal(
      await next.get(rows[queries[0]][0]),
      rows[queries[0]][1] + rows.length,
    );
  });
console.log(
  JSON.stringify({
    implementation: "typescript",
    ...samples,
    objects,
    stored_bytes,
    height,
    prefix_count,
    hot_ops: input.hot,
    mixed_ops: queries.length,
    cold_ops: input.cold,
  }),
);
