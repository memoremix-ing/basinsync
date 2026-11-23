/** Client logical edits: immutable snapshots and canonical storage measured separately. */
import assert from "node:assert/strict";
import { Basin, MemoryStorage, key, hex } from "./structures/core";
import { TrieEditor, type Consumer } from "./structures/trie";
import { VectorEditor } from "./structures/vector";
const input = JSON.parse(await Bun.stdin.text()),
  kind = Bun.env.STRUCTURE_KIND!,
  start = BigInt(input.start),
  n = input.entries.length;
assert(["trie", "vector", "collection"].includes(kind));
const rows: [Uint8Array, number][] = input.entries.map(
  ([k, v]: [string, number]) => [key(k), v],
);
const indices = rows.map(([, v]) => start + BigInt(v)),
  views = rows.map(([k]) => new DataView(k.buffer, k.byteOffset, k.byteLength));
const appended: Uint8Array[] = input.appended.map(key),
  appendViews = appended.map(
    (k) => new DataView(k.buffer, k.byteOffset, k.byteLength),
  );
let Eager: any, expire: (() => void) | undefined;
if (kind === "collection") {
  const p = Bun.env.TRIE_COST_COLLECTION_ADAPTER!;
  Eager = (await import(`${p}/collection.ts`)).EagerCollection;
  expire = (await import(`${p}/change-management/change-management.ts`)).expire;
}
let entryCalls = 0;
const consumer: Consumer<number, bigint> = {
  migration: 7,
  empty: 0n,
  entry: () => {
    entryCalls++;
    return 1n;
  },
  combine: (s) => s.reduce((a, b) => a + b, 0n),
};
function build(data = rows) {
  if (kind === "collection") {
    const c = new Eager();
    for (const [k, v] of data)
      c.set(new DataView(k.buffer, k.byteOffset, k.byteLength), v);
    return c;
  }
  const b = new Basin(new MemoryStorage(), {
    seed: new Uint8Array(32).fill(42),
  });
  return kind === "trie"
    ? TrieEditor.from(b, data, consumer)
    : VectorEditor.from(
        b,
        start + BigInt(n),
        data.map(([, v], i) => [indices[i], v] as const),
        consumer,
      );
}
const get = (c: any, i: number) =>
  kind === "collection"
    ? c.get(views[i])?.[0]
    : c.get(kind === "trie" ? rows[i][0] : indices[i]);
const set = (c: any, i: number, v: number) => {
  if (kind === "collection") {
    c.set(views[i], v);
    return c;
  }
  return c.set(kind === "trie" ? rows[i][0] : indices[i], v);
};
const clone = (c: any) =>
  kind === "collection" ? new Eager(c.cfg, c.use()) : c;
const samples: Record<string, number> = {};
function phase<T>(name: string, fn: () => T): T {
  const t = performance.now(),
    v = fn();
  samples[name + "_ms"] = performance.now() - t;
  return v;
}
let warm = build(rows.slice(0, 256));
for (let i = 0; i < 256; i++) assert.equal(get(warm, i), i);
const initial = phase("build", () => build());
for (let j = 0; j < 8192; j++)
  assert.equal(get(initial, input.queries[j % 64]), input.queries[j % 64]);
phase("hot", () => {
  for (let j = 0; j < input.hot; j++) {
    const i = input.queries[j % 64];
    assert.equal(get(initial, i), i);
  }
});
// Warm the edit paths independently so the first timed phase does not pay their JIT cost.
let editedWarm = clone(initial);
for (let j = 0; j < 8192; j++) {
  expire?.();
  editedWarm = set(editedWarm, input.queries[j % input.queries.length], -j - 1);
}
let appendWarm = clone(initial);
for (let j = 0; j < 1024; j++) {
  expire?.();
  if (kind === "collection") appendWarm.set(appendViews[j], n + j);
  else
    appendWarm =
      kind === "vector"
        ? appendWarm.push(n + j)
        : appendWarm.set(appended[j], n + j);
}
let final: any,
  expected: Map<number, number> = new Map();
for (const snapshots of [false, true]) {
  let state = clone(initial);
  const versions: { root: any; i: number; value: number }[] = [];
  const model = new Map<number, number>();
  expire?.();
  phase(snapshots ? "snapshot_edits" : "batch_edits", () => {
    for (let j = 0; j < input.edits; j++) {
      if (snapshots) expire?.();
      const i = input.queries[j % input.queries.length],
        value = -j - 1;
      state = set(state, i, value);
      if (snapshots && j % 32 === 0)
        versions.push({ root: clone(state), i, value });
    }
  });
  for (let j = 0; j < input.edits; j++)
    model.set(input.queries[j % input.queries.length], -j - 1);
  for (let i = 0; i < n; i++) {
    assert.equal(get(initial, i), i, "original snapshot");
    assert.equal(get(state, i), model.get(i) ?? i);
  }
  for (const v of versions)
    assert.equal(get(v.root, v.i), v.value, "intermediate snapshot");
  if (snapshots) {
    final = state;
    expected = model;
  }
}
let grown = clone(initial);
expire?.();
phase("append", () => {
  for (let j = 0; j < input.edits; j++) {
    expire?.();
    if (kind === "collection") grown.set(appendViews[j], n + j);
    else
      grown =
        kind === "vector" ? grown.push(n + j) : grown.set(appended[j], n + j);
  }
});
for (let j = 0; j < input.edits; j++)
  assert.equal(
    kind === "collection"
      ? grown.get(appendViews[j])?.[0]
      : grown.get(kind === "vector" ? start + BigInt(n + j) : appended[j]),
    n + j,
  );
if (kind !== "collection") {
  let rebuilt: any;
  phase("rebuild_edits", () => {
    let current = rows;
    for (let j = 0; j < input.rebuilds; j++) {
      const i = input.queries[j % input.queries.length];
      current = current.map(([k, v], at) => [k, at === i ? -j - 1 : v]);
      rebuilt = build(current);
    }
  });
  assert.equal(
    get(rebuilt, input.queries[(input.rebuilds - 1) % input.queries.length]),
    -input.rebuilds,
  );
  assert.equal(
    entryCalls,
    0,
    "logical edits must not aggregate, hash or store",
  );
  const t = performance.now();
  const stored = await final.store();
  samples.export_ms = performance.now() - t;
  for (const i of input.queries.slice(0, 128))
    assert.equal(
      await stored.get(kind === "trie" ? rows[i][0] : indices[i]),
      expected.get(i) ?? i,
    );
  samples.export_objects = stored.basin.storage.objects.size;
  samples.export_bytes = [...stored.basin.storage.objects.values()].reduce(
    (s: any, v: any) => s + v.bytes.length,
    0,
  );
}
console.log(
  JSON.stringify({
    kind,
    ...samples,
    hot_ops: input.hot,
    edit_ops: input.edits,
    rebuild_ops: input.rebuilds,
    validated_entries: n,
    validated_snapshots: Math.ceil(input.edits / 32),
  }),
);
