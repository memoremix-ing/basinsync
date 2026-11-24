import { test, expect } from "bun:test";
import { TrieMap } from "./structures/logical-trie";
import { Trie, TrieEditor, plain } from "./structures/trie";
import { TrieView } from "./structures/trie-view";
import { Basin, MemoryStorage, utf8, hex, type Edge } from "./structures/core";
const text = (b: Uint8Array) => new TextDecoder().decode(b),
  seed = new Uint8Array(32).fill(42);
const paths = (n = 6000) =>
  Array.from(
    { length: n },
    (_, i) =>
      [utf8(`/src/${i.toString().padStart(6, "0")}`), i] as [
        Uint8Array,
        number,
      ],
  );
function nodes(n: any, out = new Set<any>()) {
  out.add(n);
  if (n.kind === 1) for (const [, c] of n.children) nodes(c, out);
  return out;
}
test("relative handles share descendants across prefix extraction/graft and preserve canonical roots", async () => {
  const input = paths(),
    map = TrieMap.from(input),
    prefix = utf8("/src/"),
    selected = map.subtree(prefix),
    copied = map.graftPrefix(utf8("/copy/"), selected);
  expect(selected.size).toBe(input.length);
  expect(copied.size).toBe(input.length * 2);
  expect(copied.get(utf8("/copy/005999"))).toBe(5999);
  expect(map.has(utf8("/copy/005999"))).toBe(false);
  const before = nodes((map as any).tree),
    after = nodes((copied as any).tree);
  expect([...after].filter((n) => before.has(n)).length).toBeGreaterThan(10);
  const { subtree, rest } = copied.splitPrefix(prefix);
  expect(rest.size).toBe(input.length);
  expect(subtree.get(utf8("005999"))).toBe(5999);
  expect(() => copied.graftPrefix(prefix, subtree)).toThrow("not empty");
  expect(copied.graftPrefix(prefix, TrieMap.from([]), "replace").size).toBe(
    input.length,
  );
  const b = new Basin(new MemoryStorage(), { seed }),
    c = plain;
  const editor = TrieEditor.from(b, input, c),
    stored = await editor
      .graftPrefix(utf8("/copy/"), editor.subtree(prefix))
      .store();
  const fresh = await Trie.build(
    b,
    [
      ...input,
      ...input.map(
        ([k, v]) =>
          [utf8("/copy/" + text(k).slice(5)), v] as [Uint8Array, number],
      ),
    ],
    c,
  );
  expect(stored.root[6].sha384).toEqual(fresh.root[6].sha384);
});
test("prefix split/graft fuzz agrees with eager model including empty and all-ff boundaries", () => {
  let n = 42;
  const rnd = () => (n = (Math.imul(n, 1664525) + 1013904223) >>> 0);
  let t = TrieMap.from<number>(
    Array.from(
      { length: 3000 },
      (_, i) => [i.toString(16).padStart(4, "0"), i] as const,
    ),
  );
  let model = new Map([...t.entries()].map(([k, v]) => [hex(k), v]));
  for (let step = 0; step < 300; step++) {
    const p = (rnd() % 256).toString(16).padStart(2, "0"),
      q = (rnd() % 256).toString(16).padStart(2, "0");
    const selected = t.subtree(p);
    const old = t;
    if (step % 3 === 0) {
      t = t.deletePrefix(p);
      for (const k of model.keys()) if (k.startsWith(p)) model.delete(k);
    } else {
      t = t.graftPrefix(q, selected, "replace");
      const copy = [...model]
        .filter(([k]) => k.startsWith(p))
        .map(([k, v]) => [q + k.slice(p.length), v] as const);
      for (const k of model.keys()) if (k.startsWith(q)) model.delete(k);
      for (const [k, v] of copy) model.set(k, v);
    }
    expect([...t.entries()].map(([k, v]) => [hex(k), v])).toEqual(
      [...model].sort(([a], [b]) => a.localeCompare(b)),
    );
    if (step % 20 === 0)
      expect([...old.entries()].every(([k, v]) => old.get(k) === v)).toBe(true);
  }
  const root = t.subtree("");
  expect([...root.entries()]).toEqual([...t.entries()]);
  expect(t.deletePrefix("").size).toBe(0);
  let special = TrieMap.from([
    ["", 0],
    ["ff", 1],
    ["ffff", 2],
    ["ff00", 3],
  ]);
  expect(special.subtree("ff").size).toBe(3);
  expect(special.subtree("ff").get("")).toBe(1);
  expect(special.deletePrefix("ff").get("")).toBe(0);
});
test("lazy prefix moves clone source graphs without fetching excluded descendants", async () => {
  class Trace extends MemoryStorage {
    seen: Edge[] = [];
    override async get(e: Edge) {
      this.seen.push(e);
      return super.get(e);
    }
  }
  const storage = new Trace(),
    b = new Basin(storage, { seed }),
    data = [...paths(20000), [utf8("/other"), -1] as [Uint8Array, number]],
    trie = await Trie.build(b, data, plain);
  const view = TrieView.from(trie);
  b.clearCache();
  storage.reads = 0;
  const { subtree, rest } = view.splitPrefix(utf8("/src/"));
  const next = await rest.graftPrefix(utf8("/dst/"), subtree, "replace");
  expect(storage.reads).toBe(0);
  expect(await next.get(utf8("/dst/019999"))).toBe(19999);
  expect(await next.get(utf8("/src/019999"))).toBeUndefined();
  b.clearCache();
  storage.reads = 0;
  expect(
    (await Array.fromAsync(next.deletePrefix(utf8("/dst/")).entries())).map(
      ([k, v]) => [text(k), v],
    ),
  ).toEqual([["/other", -1]]);
  expect(storage.reads).toBeLessThanOrEqual(3);
  const old = await trie.get(utf8("/src/000001"));
  expect(old).toBe(1);
  await expect(view.graftPrefix(utf8("/src/"), subtree)).rejects.toThrow(
    "not empty",
  );
  await expect(
    view.movePrefix(utf8("/src/"), utf8("/src/nested/")),
  ).rejects.toThrow("inside source");
  const moved = await view.movePrefix(utf8("/src/"), utf8("/moved/"));
  expect(await moved.get(utf8("/moved/000001"))).toBe(1);
});
test("lazy overlay point/range precedence, replacement, nested routes and export match a model", async () => {
  const b = new Basin(new MemoryStorage(), { seed }),
    rows = paths(1800),
    source = await Trie.build(b, rows, plain);
  let v = TrieView.from(source);
  v = v.set(utf8("/src/000001"), -1).delete(utf8("/src/000002"));
  v = await v.copyPrefix(utf8("/src/"), utf8("/dst/"));
  v = v.deletePrefix(utf8("/dst/000")).set(utf8("/dst/000x"), 9);
  const sub = v.subtree(utf8("/dst/"));
  v = await v.graftPrefix(utf8("/third/"), sub);
  expect(await v.get(utf8("/third/000x"))).toBe(9);
  expect(await v.get(utf8("/third/001799"))).toBe(1799);
  expect(await v.get(utf8("/dst/000001"))).toBeUndefined();
  const out = await Array.fromAsync(v.entries()),
    keys = out.map(([k]) => hex(k));
  expect(keys).toEqual([...keys].sort());
  expect(new Set(keys).size).toBe(keys.length);
  const stored = await v.store(),
    fresh = await Trie.build(b, out, plain);
  expect(stored.root[6].sha384).toEqual(fresh.root[6].sha384);
  expect(await stored.get(utf8("/dst/000x"))).toBe(9);
  expect(await source.get(utf8("/src/000001"))).toBe(1);
  expect(await v.subtree(utf8("/third/")).has(utf8("001799"))).toBe(true);
});
test("exclusion filters prune whole roots before I/O and returned keys remain owned", async () => {
  const b = new Basin(new MemoryStorage(), { seed }),
    t = await Trie.build(b, paths(), plain);
  b.clearCache();
  const s = b.storage as MemoryStorage;
  s.reads = 0;
  expect(
    await Array.fromAsync(
      t.entries(new Uint8Array(), undefined, [new Uint8Array()]),
    ),
  ).toEqual([]);
  expect(s.reads).toBe(0);
  const m = TrieMap.from([
    ["", 1],
    ...Array.from(
      { length: 300 },
      (_, i) => [i.toString(16).padStart(4, "0"), i] as [string, number],
    ),
  ]);
  const it = m.entries();
  it.next().value![0].fill(255);
  expect([...it].every(([k, v]) => m.get(k) === v)).toBe(true);
});

test("editor prefix helpers preserve component boundaries and reject self-descendant moves", () => {
  const b = new Basin(new MemoryStorage()),
    e = TrieEditor.from(
      b,
      [
        [utf8("/a/file"), 1],
        [utf8("/ab/file"), 2],
      ],
      plain,
    );
  const moved = e.movePrefix(utf8("/a/"), utf8("/b/"));
  expect(moved.has(utf8("/a/file"))).toBe(false);
  expect(moved.get(utf8("/ab/file"))).toBe(2);
  expect(moved.get(utf8("/b/file"))).toBe(1);
  expect(e.copyPrefix(utf8("/a/"), utf8("/c/")).get(utf8("/a/file"))).toBe(1);
  expect(() => e.movePrefix(utf8("/a/"), utf8("/a/deep/"))).toThrow("inside");
  expect(() => e.copyPrefix(utf8("/missing/"), utf8("/new/"))).toThrow();
});

test("lazy splice fuzz matches an eager model across nested point/prefix overrides", async () => {
  const b = new Basin(new MemoryStorage()),
    data = Array.from(
      { length: 800 },
      (_, i) =>
        [utf8(`/g${i % 16}/${String(i).padStart(4, "0")}`), i] as [
          Uint8Array,
          number,
        ],
    );
  let v = TrieView.from(await Trie.build(b, data, plain)),
    model = new Map(data.map(([k, n]) => [text(k), n]));
  let state = 42;
  const rnd = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 80; step++) {
    const from = `/g${rnd() % 16}/`,
      to = `/g${rnd() % 16}/`,
      choice = step % 4;
    if (choice === 0) {
      v = v.deletePrefix(utf8(from));
      for (const k of model.keys()) if (k.startsWith(from)) model.delete(k);
    } else if (choice === 1) {
      const name = from + "special";
      v = v.set(utf8(name), -step);
      model.set(name, -step);
    } else if (choice === 2) {
      const handle = v.subtree(utf8(from)),
        copy = [...model]
          .filter(([k]) => k.startsWith(from))
          .map(([k, n]) => [to + k.slice(from.length), n] as const);
      v = await v.graftPrefix(utf8(to), handle, "replace");
      for (const k of model.keys()) if (k.startsWith(to)) model.delete(k);
      for (const [k, n] of copy) model.set(k, n);
    } else {
      const name = from + "special";
      v = v.delete(utf8(name));
      model.delete(name);
    }
    if (step % 8 === 0) {
      const rows = await Array.fromAsync(v.entries());
      expect(rows.map(([k, n]) => [text(k), n])).toEqual(
        [...model].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      for (const [k, n] of [...model].slice(0, 20))
        expect(await v.get(utf8(k))).toBe(n);
    }
  }
});

test("shared subtrees cannot silently overflow the logical size counter", () => {
  let tree = TrieMap.from([["", 1]]),
    rejected = false;
  for (let i = 0; i < 64; i++) {
    try {
      tree = tree.graftPrefix(new Uint8Array([i]), tree, "replace");
    } catch (e) {
      expect((e as Error).message).toContain("safe integer");
      rejected = true;
      break;
    }
  }
  expect(rejected).toBe(true);
  expect(Number.isSafeInteger(tree.size)).toBe(true);
});
