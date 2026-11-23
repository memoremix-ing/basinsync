/** Numeric vector indices versus UTF-8 Lexidecimal dictionary keys; benchmark-only logical nodes. */
import assert from "node:assert/strict";
import {
  Basin,
  MemoryStorage,
  allocated,
  hex,
  query,
  key,
  type Edge,
  type Node,
  type PendingEdge,
} from "./structures/core";
import { Trie, type Consumer } from "./structures/trie";
import { Vector } from "./structures/vector";
const input = JSON.parse(await Bun.stdin.text());
const start = BigInt(input.start),
  n = input.entries.length;
const rows: [Uint8Array, number][] = input.entries.map(
  ([k, v]: [string, number]) => [key(k), v],
);
const indices = rows.map(([, v]) => start + BigInt(v));
const views = rows.map(
  ([k]) => new DataView(k.buffer, k.byteOffset, k.byteLength),
);
const queries: number[] = input.queries,
  hot = queries.slice(0, 64),
  sequential: number[] = input.sequential;
const kind = Bun.env.STRUCTURE_KIND!,
  logical = Bun.env.STRUCTURE_TIER === "logical";
assert(["trie", "vector", "collection"].includes(kind));
assert(kind !== "collection" || logical);
const consumer: Consumer<number, bigint> = {
  migration: 7,
  empty: 0n,
  entry: () => 1n,
  combine: (s) => s.reduce((a, b) => a + b, 0n),
};
class LogicalBasin extends Basin {
  readonly nodes = new Map<Edge, Node>();
  private counter = 0;
  override async seal(node: Node, edges: Edge[]): Promise<Edge> {
    node[3] = query(edges);
    const digest = new Uint8Array(48),
      entropy = new Uint8Array(32);
    new DataView(digest.buffer).setUint32(0, ++this.counter);
    new DataView(entropy.buffer).setUint32(0, this.counter);
    const pending: PendingEdge = [
      Symbol.match,
      node[1],
      node[2],
      node[3],
      0,
      node[5],
      {
        0: node[6][0] as number,
        1: node[6][1],
        version: 0,
        length: 0,
        weight: 0n,
        sha384: digest,
        entropy,
        rotation: 0,
      },
    ];
    const edge = allocated(
      pending,
      `00000000-0000-4000-8000-${this.counter.toString(16).padStart(12, "0")}`,
    );
    this.nodes.set(edge, node);
    return edge;
  }
}
function cmp(a: Uint8Array, b: Uint8Array, offset: number) {
  const count = Math.min(a.length, b.length - offset);
  for (let i = 0; i < count; i++) {
    const d = a[i] - b[offset + i];
    if (d) return d;
  }
  return a.length - (b.length - offset);
}
function find(g: any, key: Uint8Array, offset: number): number | undefined {
  let lo = 0,
    hi = g.keys.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (cmp(g.keys[m], key, offset) < 0) lo = m + 1;
    else hi = m;
  }
  return lo < g.keys.length && cmp(g.keys[lo], key, offset) === 0
    ? g.values[lo]
    : undefined;
}
function trieGet(b: LogicalBasin, root: Node, k: Uint8Array) {
  let node: any = root,
    offset = 0;
  for (let depth = 0; ; depth++) {
    assert(depth < 256);
    const p = node[5].prefix;
    if (p) {
      if (k.length - offset < p.length) return undefined;
      for (let j = 0; j < p.length; j++)
        if (p[j] !== k[offset + j]) return undefined;
      offset += p.length;
    }
    const own = find(node[6][2], k, offset);
    if (own !== undefined) return own;
    if (offset === k.length) return undefined;
    const m = node[6][3]?.[k[offset] >> 4];
    if (!m) return undefined;
    if (!Array.isArray(m)) return find(m, k, offset);
    const child = m[k[offset] & 15];
    if (!child) return undefined;
    offset++;
    node = Array.isArray(child) ? b.nodes.get(child as Edge) : child;
    assert(node);
  }
}
function vectorGet(b: LogicalBasin, root: Node, i: bigint) {
  let node: any = root,
    local = i;
  if (i >= node[5].length) return undefined;
  for (let depth = 0; depth < 256; depth++) {
    const h = node[5],
      bitmap = node[6][2],
      slot = Number((local >> BigInt(h.shift)) & 31n);
    if (!((bitmap >>> slot) & 1)) return undefined;
    let bits = (bitmap & (2 ** slot - 1)) >>> 0,
      rank = 0;
    while (bits) {
      bits = (bits & (bits - 1)) >>> 0;
      rank++;
    }
    const at = node[6][3][rank];
    if (!h.shift) return at;
    local %= 1n << BigInt(h.shift);
    node = Array.isArray(at) ? b.nodes.get(at as Edge) : at;
    assert(node);
  }
  throw Error("vector nesting");
}
let Eager: any, expire: (() => unknown) | undefined;
if (kind === "collection") {
  const p = Bun.env.TRIE_COST_COLLECTION_ADAPTER;
  assert(p, "set TRIE_COST_COLLECTION_ADAPTER");
  Eager = (await import(`${p}/collection.ts`)).EagerCollection;
  expire = (await import(`${p}/change-management/change-management.ts`)).expire;
}
async function build(data: typeof rows, positions: bigint[]) {
  if (kind === "collection") {
    const c = new Eager();
    for (const [k, v] of data)
      c.set(new DataView(k.buffer, k.byteOffset, k.byteLength), v);
    return { value: c };
  }
  const storage = new MemoryStorage(),
    basin = logical
      ? new LogicalBasin(storage, { seed: new Uint8Array(32).fill(42) })
      : new Basin(storage, { seed: new Uint8Array(32).fill(42) });
  const value =
    kind === "trie"
      ? await Trie.build(basin, data, consumer)
      : await Vector.buildEntries(
          basin,
          start + BigInt(n),
          data.map(([, v], i) => [positions[i], v] as [bigint, number]),
          consumer,
        );
  return {
    value,
    storage,
    basin,
    root: logical ? (basin as LogicalBasin).nodes.get(value.root) : undefined,
  };
}
function read(
  state: any,
  i: number,
): number | undefined | Promise<number | undefined> {
  if (kind === "collection") return state.value.get(views[i])?.[0];
  if (logical)
    return kind === "trie"
      ? trieGet(state.basin, state.root, rows[i][0])
      : vectorGet(state.basin, state.root, indices[i]);
  return kind === "trie"
    ? state.value.get(rows[i][0])
    : state.value.get(indices[i]);
}
const warm = await build(rows.slice(0, 256), indices.slice(0, 256));
for (let i = 0; i < 256; i++) assert.equal(await read(warm, i), rows[i][1]);
const samples: Record<string, number> = {};
let state: any;
async function phase(name: string, fn: () => Promise<void>) {
  const before = state?.storage?.reads ?? 0,
    t = performance.now();
  await fn();
  samples[name + "_ms"] = performance.now() - t;
  samples[name + "_reads"] = (state?.storage?.reads ?? 0) - before;
}
await phase("build", async () => {
  state = await build(rows, indices);
});
if (kind === "collection") assert.equal(state.value.size(), n);
else assert.equal(state.value.root[5].count, BigInt(n));
if (kind === "vector") assert.equal(state.value.length, start + BigInt(n));
const footprint = logical
  ? {}
  : {
      root_sha384: hex(state.value.root[6].sha384),
      objects: state.storage.objects.size,
      stored_bytes: [...state.storage.objects.values()].reduce(
        (s: number, v: any) => s + v.bytes.length,
        0,
      ),
      height: state.value.root[3].height,
    };
for (let j = 0; j < input.warm; j++) {
  const i = hot[j % hot.length];
  assert.equal(await read(state, i), rows[i][1]);
}
await phase("hot", async () => {
  if (logical)
    for (let j = 0; j < input.hot; j++) {
      const i = hot[j % hot.length];
      assert.equal(read(state, i), rows[i][1]);
    }
  else
    for (let j = 0; j < input.hot; j++) {
      const i = hot[j % hot.length];
      assert.equal(await read(state, i), rows[i][1]);
    }
});
await phase("spread", async () => {
  for (const i of queries) assert.equal(await read(state, i), rows[i][1]);
});
if (!logical) {
  state.basin.clearCache();
  await phase("sequential", async () => {
    for (const i of sequential) assert.equal(await read(state, i), rows[i][1]);
  });
  await phase("cold", async () => {
    for (const i of queries.slice(0, input.cold)) {
      state.basin.clearCache();
      assert.equal(await read(state, i), rows[i][1]);
    }
  });
}
if (logical)
  for (let i = 0; i < n; i++) assert.equal(read(state, i), rows[i][1]);
const missing = start + BigInt(n);
if (kind === "vector")
  assert.equal(
    logical
      ? vectorGet(state.basin, state.root, missing)
      : await state.value.get(missing),
    undefined,
  );
if (kind === "collection") expire!();
console.log(
  JSON.stringify({
    kind,
    tier: logical ? "logical" : "serialized",
    ...samples,
    ...footprint,
    hot_ops: input.hot,
    spread_ops: queries.length,
    sequential_ops: sequential.length,
    cold_ops: input.cold,
    validated_all: logical,
  }),
);
