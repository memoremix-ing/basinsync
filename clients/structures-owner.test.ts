import { test, expect } from "bun:test";
import { TrieMap, trieMutationMetrics } from "./structures/logical-trie";
import { Basin, MemoryStorage, utf8, hex } from "./structures/core";
import { TrieEditor, plain } from "./structures/trie";
import { produceTrie } from "./structures/cow";
import { produceTrieProxy } from "./structures/cow-proxy";
const b = () =>
  new Basin(new MemoryStorage(), { seed: new Uint8Array(32).fill(42) });
const entries = (t: { entries(): Iterable<[Uint8Array, unknown]> }) =>
  [...t.entries()].map(([k, v]) => [hex(k), v] as [string, unknown]);

test("owned writes reuse private nodes and freeze snapshots/iterators before later edits", () => {
  const base = TrieMap.from(
    Array.from(
      { length: 10000 },
      (_, i) => [i.toString(16).padStart(6, "0"), i] as const,
    ),
  );
  const m = trieMutationMetrics(),
    d = base.mutate(m);
  for (let i = 0; i < 128; i++) d.set("000001", 10000 + i);
  expect(m.copies).toBeLessThan(10);
  expect(m.reuses).toBeGreaterThan(100);
  const held = d.snapshot(),
    it = d.entries();
  d.set("000001", 20000);
  d.delete("000002");
  const done = d.finish();
  expect(base.get("000001")).toBe(1);
  expect(held.get("000001")).toBe(10127);
  expect(new Map([...it].map(([k, v]) => [hex(k), v])).get("000001")).toBe(
    10127,
  );
  expect(done.get("000001")).toBe(20000);
  expect(done.has("000002")).toBe(false);
  for (const call of [
    () => d.get(""),
    () => d.set("", 1),
    () => d.snapshot(),
    () => d.finish(),
    () => d.entries(),
  ])
    expect(call).toThrow("closed");
});

test("snapshot subtree aliases and independent mutation owners never share writable branches", () => {
  const base = TrieMap.from(
    Array.from(
      { length: 4096 },
      (_, i) => ["aa" + i.toString(16).padStart(4, "0"), i] as const,
    ),
  );
  const d = base.mutate();
  d.set("aa0001", -1);
  const snapshot = d.snapshot(),
    subtree = snapshot.subtree("aa"),
    other = snapshot.mutate();
  d.graftPrefix("bb", subtree);
  d.graftPrefix("cc", subtree);
  d.set("bb0001", 42);
  d.delete("cc0002");
  d.deletePrefix("aa");
  other.set("aa0001", 99);
  const final = d.finish();
  expect(final.get("cc0001")).toBe(-1);
  expect(final.get("bb0001")).toBe(42);
  expect(final.has("bb0002")).toBe(true);
  expect(final.has("cc0002")).toBe(false);
  expect(snapshot.get("aa0001")).toBe(-1);
  expect(base.get("aa0001")).toBe(1);
  expect(other.finish().get("aa0001")).toBe(99);
});

test("owned insertion, deletion, collapse and empty/prefix keys match persistent snapshots", () => {
  let expected = TrieMap.from<number | undefined>([]),
    d = expected.mutate(),
    state = 12345;
  const held: [TrieMap<number | undefined>, [string, unknown][]][] = [];
  for (let i = 0; i < 3000; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const k =
      i % 97 === 0
        ? ""
        : i % 31 === 0
          ? "ab"
          : i % 19 === 0
            ? "abcd"
            : (state % 1400).toString(16).padStart(4, "0");
    if (i % 4 === 0) {
      d.delete(k);
      expected = expected.delete(k);
    } else {
      const v = i % 113 === 0 ? undefined : i;
      d.set(k, v);
      expected = expected.set(k, v);
    }
    if (i % 113 === 0) {
      const snap = d.snapshot();
      expect(entries(snap)).toEqual(entries(expected));
      held.push([snap, entries(expected)]);
    }
  }
  expect(entries(d.finish())).toEqual(entries(expected));
  for (const [snapshot, rs] of held) expect(entries(snapshot)).toEqual(rs);
  const cap = TrieMap.from(
    Array.from(
      { length: 255 },
      (_, i) => [i.toString(16).padStart(4, "0"), i] as const,
    ),
  );
  const edit = cap.mutate();
  edit.set("ff00", 1);
  edit.delete("ff00");
  expect(entries(edit.finish())).toEqual(entries(cap));
});

test("abort and failed structural writes close the owner; no-op finish preserves identity", () => {
  const base = TrieMap.from([["ab", 1]]);
  const noop = base.mutate();
  noop.set("ab", 1);
  noop.delete("ac");
  expect(noop.finish()).toBe(base);
  const d = base.mutate();
  d.set("ab", 2);
  const snapshot = d.snapshot();
  d.set("ab", 3);
  d.abort();
  expect(snapshot.get("ab")).toBe(2);
  expect(base.get("ab")).toBe(1);
  expect(() => d.finish()).toThrow("closed");
  const bad = base.mutate();
  bad.set("ac", 4);
  expect(() => bad.graftPrefix("", base)).toThrow();
  expect(() => bad.finish()).toThrow("closed");
  expect(base.get("ac")).toBeUndefined();
});

test("editor mutations preserve canonical exports and enforce graft contexts", async () => {
  const basin = b(),
    base = TrieEditor.from(
      basin,
      Array.from(
        { length: 5000 },
        (_, i) => [i.toString(16).padStart(6, "0"), i] as const,
      ),
      plain,
    );
  const d = base.mutate();
  for (let i = 0; i < 1000; i++) d.set(i.toString(16).padStart(6, "0"), i + 1);
  const snapshot = d.snapshot();
  d.set("000001", 9999);
  const done = d.finish();
  const canonical = TrieEditor.from(basin, done.entries(), plain);
  expect((await done.store()).root[6].sha384).toEqual(
    (await canonical.store()).root[6].sha384,
  );
  expect(snapshot.get("000001")).toBe(2);
  expect(base.get("000001")).toBe(1);
  const wrong = base.mutate();
  expect(() =>
    wrong.graftPrefix("ff", TrieEditor.from(b(), [["", 1]], plain)),
  ).toThrow("matching");
  expect(() => wrong.finish()).toThrow("closed");
});

test("owned explicit/Proxy COW match persistent mode across prefix boundaries and failures", async () => {
  const base = TrieEditor.from(
    b(),
    Array.from(
      { length: 600 },
      (_, i) => [utf8("f" + i), { meta: { n: i } }] as const,
    ),
    plain,
  );
  for (const mutation of ["owned", "persistent"] as const) {
    const options = { mutation, keyEncoding: "utf8" as const };
    const out = produceTrie(
      base,
      (d) => {
        for (let i = 0; i < 100; i++)
          d.updateIn("f1", ["meta", "n"], (n) => Number(n) + 1);
      },
      options,
    );
    const proxy = produceTrieProxy(
      base,
      (d) => {
        for (let i = 0; i < 100; i++) d.f1.meta.n++;
      },
      options,
    );
    expect(out.get(utf8("f1"))).toEqual(proxy.get(utf8("f1")));
    expect(base.get(utf8("f1"))!.meta.n).toBe(1);
    expect(produceTrie(base, () => {}, options)).toBe(base);
    expect(() =>
      produceTrie(
        base,
        (d) => {
          d.set("x", { meta: { n: 1 } });
          throw Error("abort");
        },
        options,
      ),
    ).toThrow("abort");
  }
  const expected = produceTrie(
    base,
    (d) => {
      d.updateIn("f1", ["meta", "n"], () => 44);
      d.deletePrefix("f5");
    },
    { mutation: "persistent", keyEncoding: "utf8" },
  );
  const actual = produceTrieProxy(
    base,
    (d, ops) => {
      d.f1.meta.n = 44;
      Object.keys(d);
      ops.deletePrefix("f5");
      d.f1.meta.n = 45;
    },
    { mutation: "owned", keyEncoding: "utf8" },
  );
  expect(actual.get(utf8("f1"))!.meta.n).toBe(45);
  expect(actual.has(utf8("f50"))).toBe(false);
  expect(() =>
    produceTrie(
      base,
      (d) => {
        try {
          d.graftPrefix("", base);
        } catch {}
      },
      { mutation: "owned" },
    ),
  ).toThrow("closed");
});

test("concurrent async owned scopes keep writes private through await, success and abort", async () => {
  const base = TrieEditor.from(b(), [[utf8("file"), { n: 0 }]], plain);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  const one = produceTrie(
    base,
    async (d) => {
      d.updateIn("file", ["n"], () => 1);
      await wait;
      expect(d.get("file")!.n).toBe(1);
    },
    { mutation: "owned", keyEncoding: "utf8" },
  );
  const two = produceTrieProxy(
    base,
    async (d) => {
      d.file.n = 2;
      await wait;
      expect(d.file.n).toBe(2);
    },
    { mutation: "owned", keyEncoding: "utf8" },
  );
  const aborted = produceTrie(
    base,
    async (d) => {
      d.set("file", { n: 3 });
      await wait;
      throw Error("abort");
    },
    { mutation: "owned", keyEncoding: "utf8" },
  );
  const abortCheck = aborted.then(
    () => {
      throw Error("expected abort");
    },
    (error) => {
      expect(error.message).toBe("abort");
    },
  );
  expect(base.get(utf8("file"))!.n).toBe(0);
  release();
  const [a, c] = await Promise.all([one, two]);
  await abortCheck;
  expect(a.get(utf8("file"))!.n).toBe(1);
  expect(c.get(utf8("file"))!.n).toBe(2);
  expect(base.get(utf8("file"))!.n).toBe(0);
});

test("incremental counts/heights survive deep prefix-key deletion and canonical collapse", () => {
  function audit(n: any): { count: number; levels: number } {
    if (n.kind === 0) {
      expect(n.count).toBe(n.rows.length);
      expect(n.levels).toBe(1);
      expect(n.rows.length).toBeLessThanOrEqual(255);
      return { count: n.rows.length, levels: 1 };
    }
    const children = n.children.map(([, c]: any) => audit(c));
    const count =
        (n.own ? 1 : 0) +
        children.reduce((s: number, c: any) => s + c.count, 0),
      levels = 1 + Math.max(0, ...children.map((c: any) => c.levels));
    expect(n.count).toBe(count);
    expect(n.levels).toBe(levels);
    expect(count).toBeGreaterThan(255);
    return { count, levels };
  }
  const base = TrieMap.from(
    Array.from({ length: 500 }, (_, i) => ["00".repeat(i), i] as const),
  );
  const d = base.mutate();
  d.set("00".repeat(500), 500);
  const held = d.snapshot();
  expect(audit((held as any).tree).levels).toBeGreaterThan(200);
  for (let i = 0; i < 490; i++) d.delete("00".repeat(i));
  const final = d.finish();
  expect(audit((final as any).tree)).toEqual({ count: 11, levels: 1 });
  expect(audit((base as any).tree).count).toBe(500);
  expect(held.size).toBe(501);
  const failed = base.mutate();
  expect(() => {
    for (let i = 500; i < 530; i++) failed.set("00".repeat(i), i);
  }).toThrow("nesting");
  expect(() => failed.finish()).toThrow("closed");
  expect(base.size).toBe(500);
});
