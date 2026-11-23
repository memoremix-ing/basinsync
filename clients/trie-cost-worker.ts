/** Isolated client-only cost experiments; logical mode never emits storage objects. */
import assert from "node:assert/strict";
const folder = Bun.env.TRIE_COST_SOURCE;
assert(folder, "run scripts/benchmark-trie-costs.ts");
const C = await import(`${folder}/clients/structures/core.ts`);
const { Trie } = await import(`${folder}/clients/structures/trie.ts`);
const input = JSON.parse(await Bun.stdin.text());
const rows: [Uint8Array, number][] = input.entries.map(
  ([k, v]: [string, number]) => [C.key(k), v],
);
const queries: number[] = input.queries,
  hot = queries.slice(0, 64);
const c = {
  migration: 7,
  empty: 0n,
  entry: () => 1n,
  combine: (s: bigint[]) => s.reduce((n, v) => n + v, 0n),
};
const cryptoStats: Record<
  string,
  { calls: number; ms: number; bytes: number }
> = {};
if (Bun.env.TRIE_COST_PROFILE === "1")
  for (const name of ["digest", "importKey", "sign"] as const) {
    const original = crypto.subtle[name].bind(crypto.subtle) as (
      ...args: any[]
    ) => Promise<unknown>;
    cryptoStats[name] = { calls: 0, ms: 0, bytes: 0 };
    (crypto.subtle as any)[name] = async (...args: any[]) => {
      const t = performance.now(),
        stats = cryptoStats[name];
      stats.calls++;
      stats.bytes +=
        (name === "digest"
          ? args[1]?.byteLength
          : name === "sign"
            ? args[2]?.byteLength
            : 0) ?? 0;
      try {
        return await original(...args);
      } finally {
        stats.ms += performance.now() - t;
      }
    };
  }
if (Bun.env.TRIE_COST_COLLECTION === "1") {
  const adapter = Bun.env.TRIE_COST_COLLECTION_ADAPTER;
  assert(
    adapter,
    "set TRIE_COST_COLLECTION_ADAPTER to the isolated legacy adapter",
  );
  const { EagerCollection } = await import(`${adapter}/collection.ts`);
  const views = rows.map(
    ([k, v]) =>
      [new DataView(k.buffer, k.byteOffset, k.byteLength), v] as const,
  );
  const warm = new EagerCollection();
  for (const [k, v] of views.slice(0, 256)) warm.set(k, v);
  for (const [k, v] of views.slice(0, 256)) assert.equal(warm.get(k)?.[0], v);
  const collection = new EagerCollection(),
    result: Record<string, unknown> = {};
  let start = performance.now();
  for (const [k, v] of views) collection.set(k, v);
  result.build_ms = performance.now() - start;
  for (const i of hot)
    assert.equal(collection.get(views[i][0])?.[0], views[i][1]);
  for (const ops of [input.hot, 262144]) {
    start = performance.now();
    for (let j = 0; j < ops; j++) {
      const i = hot[j % hot.length];
      assert.equal(collection.get(views[i][0])?.[0], views[i][1]);
    }
    result[ops === input.hot ? "hot_ms" : "logical_direct_ms"] =
      performance.now() - start;
  }
  for (const [k, v] of views) assert.equal(collection.get(k)?.[0], v);
  const files = [
    "collection.ts",
    "matter.ts",
    "change-management/change-management.ts",
    "result-types/result-types.ts",
  ];
  const { createHash } = await import("node:crypto");
  result.adapter_sha384 = Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        createHash("sha384")
          .update(
            new Uint8Array(await Bun.file(`${adapter}/${f}`).arrayBuffer()),
          )
          .digest("hex"),
      ]),
    ),
  );
  console.log(
    JSON.stringify({ ...result, hot_ops: input.hot, logical_ops: 262144 }),
  );
  process.exit(0);
}
class LogicalStore extends C.Basin {
  constructor(storage: unknown, options: unknown) {
    super(storage, options);
  }
  readonly nodes = new Map<object, any>();
  private counter = 0;
  async seal(node: any, edges: any[]) {
    const unique = C.distinct(edges);
    node[3] = C.query(unique);
    // Bench-only identity, not a digest/capability. No bytes are encoded or persisted.
    const entropy = new Uint8Array(32),
      digest = new Uint8Array(48);
    new DataView(entropy.buffer).setUint32(0, ++this.counter);
    new DataView(digest.buffer).setUint32(0, this.counter);
    const edge = [
      Symbol.match,
      node[1],
      node[2],
      node[3],
      0,
      node[5],
      {
        0: node[6][0],
        1: node[6][1],
        version: 0,
        revision: `00000000-0000-4000-8000-${this.counter.toString(16).padStart(12, "0")}`,
        length: 0,
        weight: 0n,
        sha384: digest,
        entropy,
        rotation: 0,
      },
    ];
    this.nodes.set(edge, node);
    return edge;
  }
}
function logicalGet(
  store: LogicalStore,
  root: any,
  raw: Uint8Array,
): number | undefined {
  let node = root,
    k = raw;
  for (let depth = 0; ; depth++) {
    assert(depth < 256);
    const prefix = node[5].prefix as Uint8Array | null;
    if (prefix) {
      if (k.length < prefix.length || !prefix.every((b, i) => b === k[i]))
        return undefined;
      k = k.subarray(prefix.length);
    }
    const find = (g: { keys: Uint8Array[]; values: number[] }) => {
      let a = 0,
        b = g.keys.length;
      while (a < b) {
        const m = (a + b) >> 1;
        if (C.compare(g.keys[m], k) < 0) a = m + 1;
        else b = m;
      }
      return a < g.keys.length && C.equal(g.keys[a], k)
        ? g.values[a]
        : undefined;
    };
    const own = find(node[6][2]);
    if (own !== undefined) return own;
    if (!k.length) return undefined;
    const member = node[6][3]?.[k[0] >> 4];
    if (!member) return undefined;
    if (!Array.isArray(member)) return find(member);
    const child = member[k[0] & 15];
    if (!child) return undefined;
    k = k.subarray(1);
    node = Array.isArray(child) ? store.nodes.get(child) : child;
    assert(node);
  }
}
const logical = Bun.env.TRIE_COST_LOGICAL === "1";
const storage = new C.MemoryStorage();
const basin = logical
  ? new LogicalStore(storage, { seed: new Uint8Array(32).fill(42) })
  : new C.Basin(storage, { seed: new Uint8Array(32).fill(42) });
const samples: Record<string, unknown> = {};
async function build(b: any, data: typeof rows) {
  if (logical) return (await Trie.buildNode(b, data, c)).node;
  return Trie.build(b, data, c);
}
const warmStore = new C.MemoryStorage(),
  warmBasin = logical
    ? new LogicalStore(warmStore, { seed: new Uint8Array(32).fill(42) })
    : new C.Basin(warmStore, { seed: new Uint8Array(32).fill(42) });
const warm = await build(warmBasin, rows.slice(0, 256));
for (const [k, v] of rows.slice(0, 256))
  assert.equal(logical ? logicalGet(warmBasin, warm, k) : await warm.get(k), v);
async function phase(name: string, fn: () => Promise<void>) {
  const before = structuredClone(cryptoStats),
    reads = storage.reads,
    start = performance.now();
  await fn();
  samples[`${name}_ms`] = performance.now() - start;
  samples[`${name}_reads`] = storage.reads - reads;
  if (Bun.env.TRIE_COST_PROFILE === "1")
    samples[`${name}_crypto`] = Object.fromEntries(
      Object.entries(cryptoStats).map(([n, v]) => [
        n,
        Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, x - (before[n] as any)[k]]),
        ),
      ]),
    );
}
let trie: any;
await phase("build", async () => {
  trie = await build(basin, rows);
});
const get = (k: Uint8Array) =>
  logical ? logicalGet(basin, trie, k) : trie.get(k);
for (const i of hot) assert.equal(await get(rows[i][0]), rows[i][1]);
await phase("hot", async () => {
  for (let j = 0; j < input.hot; j++) {
    const i = hot[j % hot.length];
    assert.equal(await get(rows[i][0]), rows[i][1]);
  }
});
await phase("mixed", async () => {
  for (const i of queries) assert.equal(await get(rows[i][0]), rows[i][1]);
});
await phase("cold", async () => {
  for (const i of queries.slice(0, 128)) {
    basin.clearCache();
    assert.equal(await get(rows[i][0]), rows[i][1]);
  }
});
if (logical) {
  const ops = 262144;
  await phase("logical_direct", async () => {
    for (let j = 0; j < ops; j++) {
      const i = hot[j % hot.length];
      assert.equal(logicalGet(basin, trie, rows[i][0]), rows[i][1]);
    }
  });
  const asyncGet = async (k: Uint8Array) => logicalGet(basin, trie, k);
  await phase("logical_await", async () => {
    for (let j = 0; j < ops; j++) {
      const i = hot[j % hot.length];
      assert.equal(await asyncGet(rows[i][0]), rows[i][1]);
    }
  });
  samples.logical_ops = ops;
  for (const [k, v] of rows) assert.equal(logicalGet(basin, trie, k), v);
} else {
  if (typeof trie.getOrDefer === "function") {
    const { resolveOperation } = await import(
      `${folder}/clients/structures/operation.ts`
    );
    const modes: ("generator" | "await")[] =
      Number(Bun.env.TRIE_COST_ROUND ?? 0) % 2
        ? ["await", "generator"]
        : ["generator", "await"];
    for (const mode of modes) {
      for (const i of hot) await trie.get(rows[i][0]);
      await phase(`hot_${mode}`, async () => {
        for (let j = 0; j < 65536; j++) {
          const i = hot[j % hot.length];
          if (mode === "await")
            assert.equal(await trie.get(rows[i][0]), rows[i][1]);
          else {
            const op = trie.getOrDefer(rows[i][0]);
            assert.equal(
              typeof op === "function" ? await resolveOperation(op) : op,
              rows[i][1],
            );
          }
        }
      });
    }
    samples.hot_direct_ops = 65536;
  }
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
  if (Bun.env.TRIE_COST_UPDATES !== "0")
    for (const n of [1, 100])
      await phase(`update${n}`, async () => {
        const next = await trie.update(
          queries
            .slice(0, n)
            .map((i) => [rows[i][0], { set: rows[i][1] + rows.length }]),
        );
        assert.equal(
          await next.get(rows[queries[0]][0]),
          rows[queries[0]][1] + rows.length,
        );
        assert.equal(await trie.get(rows[queries[0]][0]), rows[queries[0]][1]);
      });
  samples.root_sha384 = C.hex(trie.root[6].sha384);
  samples.objects = storage.objects.size;
}
console.log(
  JSON.stringify({
    ...samples,
    hot_ops: input.hot,
    mixed_ops: queries.length,
    cold_ops: 128,
  }),
);
