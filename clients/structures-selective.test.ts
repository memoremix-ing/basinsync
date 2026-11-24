import { test, expect } from "bun:test";
import {
  Basin,
  MemoryStorage,
  utf8,
  hex,
  type Edge,
  type PendingEdge,
} from "./structures/core";
import { Trie, plain, composableConsumer } from "./structures/trie";
import { TrieView } from "./structures/trie-view";
class Trace extends MemoryStorage {
  puts = 0;
  override async put(
    e: PendingEdge,
    b: Uint8Array,
    edges: readonly Edge[] = [],
  ) {
    this.puts++;
    return super.put(e, b, edges);
  }
}
const setup = () => {
  const s = new Trace();
  return { s, b: new Basin(s, { seed: new Uint8Array(32).fill(42) }) };
};
const rows = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => [i.toString(16).padStart(8, "0"), i] as [string, number],
  );
test("selective point writes preserve canonical bytes while reusing cold stored siblings", async () => {
  const { s, b } = setup(),
    input = rows(100000),
    source = await Trie.build(b, input, plain);
  b.clearCache();
  s.reads = 0;
  s.puts = 0;
  const changed = await TrieView.from(source).set("0000ffff", 999999).store();
  const gets = s.reads,
    puts = s.puts;
  const expected = await Trie.build(
    b,
    input.map(([k, v]) => [k, k === "0000ffff" ? 999999 : v]),
    plain,
  );
  expect(changed.root[6].sha384).toEqual(expected.root[6].sha384);
  expect(gets).toBeLessThan(10);
  expect(puts).toBeLessThan(10);
  expect(await changed.get("0000ffff")).toBe(999999);
  expect(await source.get("0000ffff")).toBe(65535);
});
test("selective insert/delete and prefix-splice packing match full builds at boundaries", async () => {
  for (const n of [0, 1, 254, 255, 256, 257, 1279, 1280, 1281, 5000]) {
    const { b } = setup(),
      input = rows(n),
      source = await Trie.build(b, input, plain);
    let view = TrieView.from(source)
      .set("", -1)
      .set("ffffffff", -2)
      .delete("00000000");
    const model = new Map(input);
    model.set("", -1);
    model.set("ffffffff", -2);
    model.delete("00000000");
    const got = await view.store(),
      expected = await Trie.build(b, model, plain);
    expect(got.root[6].sha384).toEqual(expected.root[6].sha384);
  }
  const { b } = setup(),
    input = Array.from(
      { length: 20000 },
      (_, i) =>
        [utf8(`/src/${i.toString().padStart(6, "0")}`), i] as [
          Uint8Array,
          number,
        ],
    );
  const source = await Trie.build(b, input, plain),
    view = TrieView.from(source);
  const copied = await view.graftPrefix(
    utf8("/nested/copy/"),
    view.subtree(utf8("/src/")),
  );
  const result = await copied
    .deletePrefix(utf8("/src/000"))
    .set(utf8("/nested/copy/x"), 99)
    .store();
  const model = input.filter(
    ([k]) => !new TextDecoder().decode(k).startsWith("/src/000"),
  );
  model.push(
    ...input.map(
      ([k, v]) =>
        [utf8("/nested/copy/" + new TextDecoder().decode(k).slice(5)), v] as [
          Uint8Array,
          number,
        ],
    ),
  );
  model.push([utf8("/nested/copy/x"), 99]);
  expect(result.root[6].sha384).toEqual(
    (await Trie.build(b, model, plain)).root[6].sha384,
  );
});
test("summary reuse is opt-in, ordered, key-aware and cannot be inherited by spreading", async () => {
  const { b } = setup();
  let calls = 0;
  const legacy = {
    migration: 7,
    empty: [] as string[],
    entry: (k: Uint8Array, _v: number) => {
      calls++;
      return [hex(k)];
    },
    combine: (s: readonly string[][]) => s.flat(),
  };
  const input = rows(2000),
    c = composableConsumer(legacy),
    source = await Trie.build(b, input, c);
  calls = 0;
  const moved = await TrieView.from(source).movePrefix("0000", "abcd");
  const got = await moved.store();
  const expected = await Trie.build(
    b,
    input.map(([k, v]) => ["abcd" + k.slice(4), v]),
    c,
  );
  expect(got.root[6].sha384).toEqual(expected.root[6].sha384);
  const nonassoc = {
    ...plain,
    entry: (_k: Uint8Array, v: number) => v,
    empty: 0,
    combine: (v: readonly number[]) => v.reduce((a, b) => a + b, 0) + v.length,
  };
  const a = await Trie.build(b, input, nonassoc),
    out = await TrieView.from(a).set("00000001", -1).store();
  expect(out.root[6].sha384).toEqual(
    (
      await Trie.build(
        b,
        input.map(([k, v]) => [k, k === "00000001" ? -1 : v]),
        nonassoc,
      )
    ).root[6].sha384,
  );
});
test("nested view edits preserve exact-key overrides and route precedence", async () => {
  const { b } = setup(),
    input: [[string, number], [string, number], [string, number]] = [
      ["aa", 1],
      ["aa00", 2],
      ["aa0001", 3],
    ];
  const source = await Trie.build(b, input, plain);
  let v = TrieView.from(source).set("aa", 9);
  v = v.replacePrefix("bb", v.subtree("aa")).delete("bb00").set("bb0000", 4);
  const out = await v.store(),
    expected = await Trie.build(
      b,
      [
        ["aa", 9],
        ["aa00", 2],
        ["aa0001", 3],
        ["bb", 9],
        ["bb0000", 4],
        ["bb0001", 3],
      ],
      plain,
    );
  expect(out.root[6].sha384).toEqual(expected.root[6].sha384);
});

test("stored editors and owned COW preserve export plans across snapshots and splices", async () => {
  const { produceTrie } = await import("./structures/cow");
  const { s, b } = setup(),
    input = rows(50000),
    source = await Trie.build(b, input, plain);
  const base = await source.edit();
  b.clearCache();
  s.puts = 0;
  s.reads = 0;
  const changed = produceTrie(base, (d) => d.set("00000001", -1), {
    mutation: "owned",
  });
  const exported = await changed.store(),
    reads = s.reads,
    puts = s.puts;
  expect(reads).toBeLessThan(10);
  expect(puts).toBeLessThan(10);
  expect(exported.root[6].sha384).toEqual(
    (
      await Trie.build(
        b,
        input.map(([k, v]) => [k, k === "00000001" ? -1 : v]),
        plain,
      )
    ).root[6].sha384,
  );
  expect(base.get("00000001")).toBe(1);
  const draft = changed.mutate();
  draft.set("00000002", -2);
  const held = draft.snapshot();
  draft.set("00000003", -3);
  const done = draft.finish();
  expect(await (await held.store()).get("00000003")).toBe(3);
  expect(await (await done.store()).get("00000003")).toBe(-3);
});
test("value-edge deduplication and degree-driven packing remain canonical", async () => {
  const { b } = setup(),
    edges: Edge[] = [];
  for (let i = 0; i < 400; i++)
    edges.push((await Trie.build(b, [["", i]], plain)).root);
  const c = composableConsumer<[Edge], null>(
    { ...plain, edges: (v) => [v[0]] },
    { keyIndependent: true },
  );
  for (const shared of [false, true]) {
    const input = Array.from(
        { length: 700 },
        (_, i) =>
          [
            i.toString(16).padStart(8, "0"),
            [edges[shared ? 0 : i % edges.length]],
          ] as [string, [Edge]],
      ),
      source = await Trie.build(b, input, c);
    const got = await TrieView.from(source)
      .delete("00000000")
      .set("ffffffff", [edges[10]])
      .store();
    expect(got.root[6].sha384).toEqual(
      (
        await Trie.build(
          b,
          [...input.slice(1), ["ffffffff", [edges[10]]] as [string, [Edge]]],
          c,
        )
      ).root[6].sha384,
    );
  }
});
test("changed packing settings rebuild and cached descriptor mutations are rejected", async () => {
  const { b } = setup(),
    source = await Trie.build(b, rows(5000), plain);
  await b.load(source.root);
  const view = TrieView.from(source);
  b.options.maxDegree = 256;
  const got = await view.set("ffffffff", 9).store(),
    expected = await Trie.build(b, [...rows(5000), ["ffffffff", 9]], plain);
  expect(got.root[6].sha384).toEqual(expected.root[6].sha384);
  const original = await Trie.build(b, rows(5000), plain);
  await b.load(original.root);
  (original.root[5] as any).count = 1n;
  await expect(TrieView.from(original).store()).rejects.toThrow("summary");
});

test("selective view fuzz agrees with a flat rebuild through nested range edits", async () => {
  const { b } = setup();
  let state = 41;
  for (let trial = 0; trial < 3; trial++) {
    const input = rows(5000).map(
      ([k, v]) => [k, v % 13 === 0 ? null : v] as [string, number | null],
    );
    let view = TrieView.from(await Trie.build(b, input, plain));
    const model = new Map(input);
    for (let step = 0; step < 120; step++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const k = (state % 12000).toString(16).padStart(8, "0"),
        from = k.slice(0, 6),
        to = (0x2000 + (state % 10000))
          .toString(16)
          .padStart(8, "0")
          .slice(0, 6);
      if (step % 7 === 0) {
        const selected = [...model].filter(([k]) => k.startsWith(from));
        view = view.replacePrefix(to, view.subtree(from));
        for (const k of model.keys()) if (k.startsWith(to)) model.delete(k);
        for (const [k, v] of selected) model.set(to + k.slice(from.length), v);
      } else if (step % 5 === 0) {
        view = view.deletePrefix(from);
        for (const k of model.keys()) if (k.startsWith(from)) model.delete(k);
      } else if (step % 3 === 0) {
        view = view.delete(k);
        model.delete(k);
      } else {
        view = view.set(k, step);
        model.set(k, step);
      }
      if (step % 12 === 11) {
        const stored = await view.store(),
          expected = await Trie.build(b, model, plain);
        expect(stored.root[6].sha384).toEqual(expected.root[6].sha384);
        view = TrieView.from(stored);
      }
    }
  }
});
