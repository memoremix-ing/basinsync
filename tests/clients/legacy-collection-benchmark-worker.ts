// Historical collection remains external; the runner prepares an isolated copy.
import assert from "node:assert/strict";
const adapter = Bun.env.LEGACY_COLLECTION_ADAPTER;
assert(adapter, "run scripts/benchmark-legacy-collection.ts");
const { EagerCollection } = await import(`${adapter}/collection.ts`);
const { expire } = await import(
  `${adapter}/change-management/change-management.ts`
);
const input = JSON.parse(await Bun.stdin.text());
const rows: [DataView, number][] = input.entries.map(
  ([h, v]: [string, number]) => {
    const b = Uint8Array.fromHex(h);
    return [new DataView(b.buffer, b.byteOffset, b.byteLength), v];
  },
);
const queries: number[] = input.queries,
  hot = queries.slice(0, 64);
const samples: Record<string, number> = {};
function phase(name: string, fn: () => void) {
  const start = performance.now();
  fn();
  samples[`${name}_ms`] = performance.now() - start;
}
const warm = new EagerCollection();
for (const [k, v] of rows.slice(0, 256)) warm.set(k, v);
for (const [k, v] of rows.slice(0, 256)) assert.equal(warm.get(k)?.[0], v);
const collection = new EagerCollection();
phase("build", () => {
  for (const [k, v] of rows) collection.set(k, v);
});
assert.equal(collection.size(), rows.length);
for (const i of hot) assert.equal(collection.get(rows[i][0])?.[0], rows[i][1]);
phase("hot", () => {
  for (let j = 0; j < input.hot; j++) {
    const i = hot[j % hot.length];
    assert.equal(collection.get(rows[i][0])?.[0], rows[i][1]);
  }
});
phase("mixed", () => {
  for (const i of queries)
    assert.equal(collection.get(rows[i][0])?.[0], rows[i][1]);
});
phase("miss", () => {
  for (const i of queries) {
    const k = new Uint8Array(rows[i][0].byteLength + 1);
    k.set(
      new Uint8Array(
        rows[i][0].buffer,
        rows[i][0].byteOffset,
        rows[i][0].byteLength,
      ),
    );
    k[k.length - 1] = 255;
    assert.equal(collection.get(new DataView(k.buffer)), undefined);
  }
});
phase("sequential", () => {
  for (const i of input.sequential)
    assert.equal(collection.get(rows[i][0])?.[0], rows[i][1]);
});
const prior = collection.use();
for (const size of [1, 100]) {
  collection.use(prior);
  expire(); // Retain original snapshot; first write must copy shared paths.
  phase(`update${size}`, () => {
    for (const i of queries.slice(0, size))
      collection.set(rows[i][0], rows[i][1] + rows.length);
    assert.equal(
      collection.get(rows[queries[0]][0])?.[0],
      rows[queries[0]][1] + rows.length,
    );
  });
  const changed = new Set(queries.slice(0, size));
  for (let i = 0; i < rows.length; i++)
    assert.equal(
      collection.get(rows[i][0])?.[0],
      rows[i][1] + (changed.has(i) ? rows.length : 0),
    );
  const snapshot = new EagerCollection(collection.cfg, prior);
  assert.equal(snapshot.size(), rows.length);
  for (const [k, v] of rows)
    assert.equal(snapshot.get(k)?.[0], v, "snapshot changed");
}
collection.use(prior);
let ordered_scan: string;
try {
  const sorted = [...rows].sort(([a], [b]) =>
    Buffer.compare(
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
    ),
  );
  for (let i = 0; i < sorted.length; i++) {
    const entry = collection.at(i);
    assert(entry);
    assert.deepEqual(entry[0], [
      ...new Uint8Array(
        sorted[i][0].buffer,
        sorted[i][0].byteOffset,
        sorted[i][0].byteLength,
      ),
    ]);
    assert.equal(entry[1], sorted[i][1]);
  }
  ordered_scan = "passed";
} catch (e) {
  ordered_scan = String(e);
}
console.log(
  JSON.stringify({
    implementation: "collection",
    ...samples,
    hot_ops: input.hot,
    mixed_ops: queries.length,
    sequential_ops: input.sequential.length,
    checked_entries: rows.length,
    checked_snapshots: 2,
    ordered_scan,
  }),
);
