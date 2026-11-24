import { test, expect } from "bun:test";
import {
  Basin,
  MemoryStorage,
  object,
  type Node,
  type Edge,
  utf8,
} from "./structures/core";
import { Vector, VectorEditor } from "./structures/vector";
import { VectorMap } from "./structures/logical-vector";
import { plain, Trie } from "./structures/trie";
import { Volume, buildBlock, sectors } from "./structures/volume";
import { produceTrie, produceTrieProxy, TrieEditor } from "./structures";
const basin = () =>
  new Basin(new MemoryStorage(), { seed: new Uint8Array(32).fill(42) });

test("consumer-selected vector widths preserve bit boundaries, holes, exports and snapshots", async () => {
  for (let bits = 1; bits <= 8; bits++) {
    const width = 1 << bits;
    const indices = [
      ...new Set([
        0,
        1,
        7,
        8,
        31,
        32,
        63,
        64,
        127,
        128,
        255,
        256,
        width - 1,
        width,
        width ** 2 - 1,
        width ** 2,
      ]),
    ].map(BigInt);
    indices.push((1n << 200n) + BigInt(width - 1));
    const length = indices.at(-1)! + 1n;
    const rows: [bigint, string][] = indices.map((i) => [i, i.toString()]);
    const b = basin(),
      stored = await Vector.buildEntries(b, length, rows, plain, { bits });
    let edit = await stored.edit(),
      logical = VectorMap.from(length, rows, bits);
    expect(stored.bits).toBe(bits);
    expect(edit.bits).toBe(bits);
    for (const [i, v] of rows) {
      expect(await stored.get(i)).toBe(v);
      expect(logical.get(i)).toBe(v);
    }
    expect(await stored.get(999n)).toBeUndefined();
    const held = edit;
    edit = edit.set(0n, "changed").delete(indices[2]).push("appended");
    logical = logical.set(0n, "changed").delete(indices[2]).push("appended");
    expect(held.get(0n)).toBe("0");
    expect(held.length).toBe(length);
    expect([...edit.entries()]).toEqual([...logical.entries()]);
    const exported = await edit.store();
    expect(exported.bits).toBe(bits);
    const changed = await stored.update(
      [
        [0n, { set: "changed" }],
        [indices[2], { delete: true }],
        [length, { set: "appended" }],
      ],
      length + 1n,
    );
    expect(changed.bits).toBe(bits);
    expect(changed.root[6].sha384).toEqual(exported.root[6].sha384);
    logical = logical.resize(BigInt(width + 1));
    expect([...logical.entries()].every(([i]) => i <= BigInt(width))).toBe(
      true,
    );
    expect(logical.bits).toBe(bits);
    const inline = await Vector.buildNodeEntries(b, length, rows, plain, {
      bits,
    });
    const framed = await b.seal(inline.node, inline.edges);
    const inlineReader = new Vector(b, await b.load(framed), plain);
    expect(await inlineReader.get(indices.at(-1)!)).toBe(
      indices.at(-1)!.toString(),
    );
  }
});

test("configurable bitmap wire format is a blob and rejects noncanonical masks and widths", async () => {
  const b = basin();
  for (const bits of [0, 9, -1, 1.5, NaN]) {
    expect(() => VectorMap.from(0n, [], bits)).toThrow("bits");
    await expect(Vector.build(b, [], plain, { bits })).rejects.toThrow("bits");
    expect(() => VectorEditor.from(b, 0n, [], plain, { bits })).toThrow("bits");
  }
  for (const bits of [1, 2, 5, 7, 8]) {
    const v = await Vector.build(
      b,
      Array.from({ length: 1 << bits }, (_, i) => i),
      plain,
      { bits },
    );
    const r = await b.load(v.root),
      bitmap = r.get("6").get(2);
    expect(bitmap.isExtension()).toBe(false);
    expect(object<Uint8Array>(bitmap)).toEqual(
      new Uint8Array(Math.ceil((1 << bits) / 8)).fill(
        bits < 3 ? (1 << (1 << bits)) - 1 : 255,
      ),
    );
    const n = object<Node>(r);
    for (const bad of [
      new Uint8Array(),
      new Uint8Array(33),
      3,
      [255],
      new Array(Math.ceil((1 << bits) / 8)).fill(0),
    ]) {
      n[6][2] = bad;
      const e = await b.seal(n, []);
      await expect(new Vector(b, e, plain).get(0n)).rejects.toThrow();
    }
  }
  const v = await Vector.build(b, [1], plain, { bits: 1 }),
    n = object<Node>(await b.load(v.root));
  n[6][2] = new Uint8Array([128]);
  await expect(
    new Vector(b, await b.seal(n, []), plain).get(0n),
  ).rejects.toThrow("bits");
});

test("public explicit and Proxy entrypoints support scoped edits", () => {
  const e = TrieEditor.from(
    basin(),
    [[utf8("file"), { meta: { n: 1 } }]],
    plain,
  );
  const path = produceTrie(
    e,
    (d) => d.updateIn("file", ["meta", "n"], (n) => (n as number) + 1),
    { keyEncoding: "utf8" },
  );
  const proxy = produceTrieProxy(
    e,
    (d) => {
      d.file.meta.n++;
    },
    { keyEncoding: "utf8" },
  );
  expect(path.get(utf8("file"))).toEqual(proxy.get(utf8("file")));
  expect(e.get(utf8("file"))!.meta.n).toBe(1);
});

test("blocks retain page tries with only leading and lagging page spines", async () => {
  const b = basin(),
    block = await buildBlock(b, [
      [0n, utf8("hello")],
      [4n, utf8("later")],
    ]);
  const r = await b.load(block.edge),
    f = r.get("6");
  expect(f.length()).toBe(5);
  expect(object<unknown[]>(f.get(3))).toEqual([]);
  expect(object<unknown[]>(f.get(4))).toEqual([]);
  const v = await Volume.fromBlocks(b, [["/file", block]]);
  expect(await v.page("/file", 4n)).toEqual(utf8("later"));
  expect(await v.page("/file", 3n)).toBeUndefined();
  expect(await v.page("/file", 0n, false)).toEqual(utf8("hello"));
});

test("seven-bit vector boundary stacks name non-root nodes at their actual basin heights", async () => {
  const { vectorBoundaryLinks } = await import("./structures/vector");
  const { link, equal } = await import("./structures/core");
  const b = basin(),
    built = await Vector.buildNode(
      b,
      Array.from({ length: 98305 }, (_, i) => i),
      plain,
      { bits: 7 },
    );
  const { leading, lagging } = await vectorBoundaryLinks(b, built.node);
  expect(leading.length).toBe(built.node[3].height);
  expect(lagging.length).toBe(leading.length);
  expect(leading.filter(Boolean).length).toBeGreaterThan(0);
  for (const [stack, last] of [
    [leading, false],
    [lagging, true],
  ] as const) {
    let node = built.node;
    const expected = new Array(node[3].height).fill(null);
    while ((node[5] as any).shift) {
      const slots = node[6][3] as (Node | Edge)[],
        child = slots[last ? slots.length - 1 : 0] as Node | Edge;
      if (Array.isArray(child)) {
        expected[child[3].height] = link(child);
        node = object<Node>(await b.load(child));
      } else node = child;
    }
    expect(stack).toEqual(expected);
    for (let h = 0; h < stack.length; h++)
      if (stack[h]) {
        expect(stack[h]!.height).toBe(h);
        const e = await (b.storage as MemoryStorage).resolve(stack[h]!);
        expect(e).toBeDefined();
        expect(e![2]).toBe(".vector-node/");
      }
  }
  const reader = new Vector(
    b,
    await b.load(await b.seal(built.node, built.edges)),
    plain,
  );
  expect(await reader.get(98304n)).toBe(98304);
});

test("unavailable page spine targets fall back to the retaining trie", async () => {
  const b = basin(),
    storage = b.storage as MemoryStorage,
    original = await buildBlock(
      b,
      Array.from(
        { length: 20000 },
        (_, i) =>
          [BigInt(i), new Uint8Array([i & 255])] as [bigint, Uint8Array],
      ),
    );
  const n = object<Node>(await b.load(original.edge));
  expect((n[6][4] as unknown[]).some(Boolean)).toBe(true);
  const volume = await Volume.fromBlocks(b, [["/file", original]]);
  let resolves = 0;
  storage.resolve = async () => {
    resolves++;
    return undefined;
  };
  const reader = new Volume(new Basin(storage), volume.root);
  expect(await reader.page("/file", 19999n)).toEqual(
    new Uint8Array([19999 & 255]),
  );
  expect(resolves).toBeGreaterThan(0);
});
