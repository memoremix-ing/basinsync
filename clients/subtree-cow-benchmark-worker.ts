/** Fresh-process benchmarks; scalar, payload and stored-view costs stay separate. */
import assert from "node:assert/strict";
import {
  Basin,
  MemoryStorage,
  utf8,
  hex,
  concat,
  type Edge,
  type PendingEdge,
} from "./structures/core";
import {
  Trie,
  TrieEditor,
  plain,
  trieMutationMetrics,
} from "./structures/trie";
import { TrieView } from "./structures/trie-view";
import { produceTrie } from "./structures/cow";
import { produceTrieProxy } from "./structures/cow-proxy";
import { cowMetrics, validateValue } from "./structures/cow-values";
const mode = Bun.env.STRUCTURE_EXPERIMENT!,
  style = Bun.env.COW_STYLE ?? "persistent",
  n = Number(Bun.env.STRUCTURE_N ?? 100000);
const seed = new Uint8Array(32).fill(42),
  metrics: any = {};
const timed = <T>(name: string, fn: () => T): T => {
  const t = performance.now(),
    out = fn();
  metrics[name + "_ms"] = performance.now() - t;
  return out;
};
const timedAsync = async <T>(name: string, fn: () => Promise<T>) => {
  const t = performance.now(),
    out = await fn();
  metrics[name + "_ms"] = performance.now() - t;
  return out;
};
class Trace extends MemoryStorage {
  gets = 0;
  getBytes = 0;
  puts = 0;
  override async get(e: Edge) {
    this.gets++;
    this.getBytes += e[6].length;
    return super.get(e);
  }
  override async put(
    e: PendingEdge,
    b: Uint8Array,
    edges: readonly Edge[] = [],
  ) {
    this.puts++;
    return super.put(e, b, edges);
  }
}
if (mode === "subtree") {
  const storage = new Trace(),
    b = new Basin(storage, { seed }),
    groups = 100,
    per = Math.floor(n / groups),
    rows = Array.from(
      { length: groups * per },
      (_, i) =>
        [
          utf8(
            `/tree/${String(Math.floor(i / per)).padStart(3, "0")}/${String(i % per).padStart(6, "0")}`,
          ),
          i,
        ] as [Uint8Array, number],
    );
  rows.push([utf8("/keep"), -1]);
  const editor = TrieEditor.from(b, rows, plain),
    source = await Trie.build(b, rows, plain),
    p = utf8("/tree/025/"),
    targets = Array.from({ length: 32 }, (_, i) =>
      utf8(`/copies/${String(i).padStart(3, "0")}/`),
    );
  const selected = rows.filter(
    ([k]) => k.length >= p.length && p.every((v, i) => k[i] === v),
  );
  let result: any;
  const before = storage.gets;
  if (style === "enumerate")
    result = timed("edit", () => {
      let state = editor;
      for (const target of targets) {
        for (const [k, v] of selected)
          state = state.set(concat([target, k.subarray(p.length)]), v);
      }
      return state;
    });
  else if (style === "handles")
    result = timed("edit", () => {
      let state = editor;
      const subtree = state.subtree(p);
      for (const target of targets)
        state = state.graftPrefix(target, subtree, "replace");
      return state;
    });
  else {
    assert.equal(style, "lazy");
    result = await timedAsync("edit", async () => {
      let state = TrieView.from(source),
        subtree = state.subtree(p);
      for (const target of targets)
        state = await state.graftPrefix(target, subtree, "replace");
      return state;
    });
  }
  metrics.edit_gets = storage.gets - before;
  assert.equal(await result.get(utf8("/copies/031/000001")), 25 * per + 1);
  assert.equal(await source.get(utf8("/copies/031/000001")), undefined);
  if (style === "lazy") {
    b.clearCache();
    const gets = storage.gets,
      bytes = storage.getBytes;
    const remaining = TrieView.from(source).deletePrefix(utf8("/tree/"));
    assert.deepEqual(
      (await Array.fromAsync(remaining.entries())).map(([k, v]) => [
        new TextDecoder().decode(k),
        v,
      ]),
      [["/keep", -1]],
    );
    metrics.prune_gets = storage.gets - gets;
    metrics.prune_bytes = storage.getBytes - bytes;
  }
  const puts = storage.puts,
    objects = storage.objects.size,
    gets = storage.gets;
  const stored: any = await timedAsync("export", () => result.store());
  metrics.export_gets = storage.gets - gets;
  metrics.export_put_attempts = storage.puts - puts;
  metrics.new_objects = storage.objects.size - objects;
  metrics.output_count = Number(stored.root[5].count);
  assert.equal(metrics.output_count, rows.length + 32 * per);
  if (style === "lazy") {
    const sourceKeys = Array.from({ length: 64 }, (_, i) =>
      utf8(`/tree/025/${String(i).padStart(6, "0")}`),
    );
    const copiedKeys = Array.from({ length: 64 }, (_, i) =>
      utf8(`/copies/031/${String(i).padStart(6, "0")}`),
    );
    for (let i = 0; i < 2048; i++) {
      await source.get(sourceKeys[i % 64]);
      await result.get(copiedKeys[i % 64]);
    }
    await timedAsync("source_cached_get", async () => {
      for (let i = 0; i < 8192; i++)
        assert.equal(await source.get(sourceKeys[i % 64]), 25 * per + (i % 64));
    });
    await timedAsync("view_cached_get", async () => {
      for (let i = 0; i < 8192; i++)
        assert.equal(await result.get(copiedKeys[i % 64]), 25 * per + (i % 64));
    });
    b.clearCache();
    const beforeCold = storage.gets;
    assert.equal(await result.get(copiedKeys[1]), 25 * per + 1);
    metrics.view_cold_gets = storage.gets - beforeCold;
    b.clearCache();
    const beforeSource = storage.gets;
    assert.equal(await source.get(sourceKeys[1]), 25 * per + 1);
    metrics.source_cold_gets = storage.gets - beforeSource;
  }
  metrics.output_sha384 = hex(stored.root[6].sha384);
  metrics.operations = targets.length;
  metrics.subtree_entries = per;
} else {
  const nested = mode !== "scalar",
    count = nested ? 256 : n,
    bytes = 16384;
  const rows: [string, any][] = Array.from({ length: count }, (_, i) => [
    i.toString(16).padStart(8, "0"),
    nested
      ? {
          meta: { n: i, mode: 420 },
          pad: Object.fromEntries(
            Array.from({ length: 64 }, (_, j) => [`p${j}`, { n: j }]),
          ),
          list: [0, 1, 2],
          bytes: new Uint8Array(bytes).fill(i & 255),
        }
      : i,
  ]);
  const initial = TrieEditor.from(
      new Basin(new MemoryStorage(), { seed }),
      rows,
      plain,
    ),
    keys = rows.map(([k]) => k),
    ops = nested ? 4096 : 65536,
    batch = Number(Bun.env.COW_BATCH ?? 64);
  const snapshots: TrieEditor<any, null>[] = [];
  function apply(
    root: TrieEditor<any, null>,
    offset: number,
    metricsCounter?: ReturnType<typeof cowMetrics>,
  ) {
    const structureCounter = metricsCounter ? trieMutationMetrics() : undefined;
    if (structureCounter) metrics.one_batch_structure = structureCounter;
    const mutation = (Bun.env.COW_MUTATION ?? "persistent") as
      | "owned"
      | "persistent";
    const indices = Array.from(
      { length: batch },
      (_, j) => (offset + j) % count,
    );
    if (style === "raw-owned") {
      const draft = root.mutate(structureCounter);
      for (const i of indices) {
        const old = nested ? draft.get(keys[i]) : undefined;
        draft.set(
          keys[i],
          nested
            ? { ...old, meta: { ...old.meta, n: old.meta.n + 1 } }
            : offset + i,
        );
      }
      return draft.finish();
    }
    if (style === "persistent") {
      for (const i of indices) {
        const old = nested ? root.get(keys[i]) : undefined;
        root = root.set(
          keys[i],
          nested
            ? { ...old, meta: { ...old.meta, n: old.meta.n + 1 } }
            : offset + i,
        );
      }
      return root;
    }
    if (style === "native") {
      const drafts = indices.map((i) => {
        const old = root.get(keys[i]);
        validateValue(old);
        return [i, structuredClone(old)] as const;
      });
      for (const [, draft] of drafts) draft.meta.n++;
      for (const [i, draft] of drafts) {
        validateValue(draft);
        root = root.set(keys[i], structuredClone(draft));
      }
      return root;
    }
    if (style === "proxy")
      return produceTrieProxy(
        root,
        (d) => {
          for (const i of indices) {
            if (nested) d[keys[i]].meta.n++;
            else d[keys[i]] = offset + i;
          }
        },
        {
          metrics: metricsCounter,
          mutation,
          structuralMetrics: structureCounter,
        },
      ) as TrieEditor<any, null>;
    return produceTrie(
      root,
      (d) => {
        for (const i of indices) {
          if (!nested) d.set(keys[i], offset + i);
          else if (style === "clone") d.edit(keys[i]).meta.n++;
          else {
            assert.equal(style, "path");
            d.updateIn(keys[i], ["meta", "n"], (n) => Number(n) + 1);
          }
        }
      },
      {
        metrics: metricsCounter,
        mutation,
        structuralMetrics: structureCounter,
      },
    ) as TrieEditor<any, null>;
  }
  let warm = initial;
  for (let i = 0; i < 1024; i += batch) warm = apply(warm, i);
  warm = initial;
  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  const final = timed("edit", () => {
    let root = initial;
    for (let i = 0; i < ops; i += batch) {
      root = apply(root, i);
      snapshots.push(root);
    }
    return root;
  });
  if (nested) {
    for (let i = 0; i < count; i++)
      assert.equal(final.get(keys[i]).meta.n, i + ops / count);
    assert.equal(initial.get(keys[0]).meta.n, 0);
    assert.equal(snapshots[0].get(keys[0]).meta.n, Math.ceil(batch / count));
  } else {
    assert.equal(initial.get(keys[0]), 0);
    assert.equal(snapshots[0].get(keys[1]), 1);
  }
  const counters = cowMetrics();
  if (style !== "native" && style !== "persistent")
    apply(initial, batch, counters);
  metrics.one_batch = counters;
  (globalThis as any).__liveRoots = [initial, final, snapshots];
  Bun.gc(true);
  metrics.heap_delta = process.memoryUsage().heapUsed - heapBefore;
  metrics.rss = process.memoryUsage().rss;
  metrics.operations = ops;
  metrics.batch = batch;
  metrics.bytes_per_value = nested ? bytes : 0;
  // Compare read-only traversal/no-op identity under each full-value interface.
  if (
    nested &&
    style !== "persistent" &&
    style !== "raw-owned" &&
    style !== "native"
  ) {
    const noop = timed("read_only", () => {
      let out = initial;
      for (let i = 0; i < 16; i++)
        out =
          style === "proxy"
            ? (produceTrieProxy(out, (d) => {
                for (const k of keys.slice(0, 64)) assert(d[k].meta.n >= 0);
              }) as any)
            : (produceTrie(out, (d) => {
                for (const k of keys.slice(0, 64)) {
                  if (style === "clone") assert(d.edit(k).meta.n >= 0);
                  else d.updateIn(k, ["meta", "n"], (x) => x);
                }
              }) as any);
      return out;
    });
    assert.equal(noop, initial);
  }
}
console.log(
  JSON.stringify({
    mode,
    style,
    n,
    mutation: Bun.env.COW_MUTATION ?? "persistent",
    ...metrics,
  }),
);
