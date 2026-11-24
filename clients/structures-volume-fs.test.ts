import { test, expect } from "bun:test";
import {
  Basin,
  MemoryStorage,
  object,
  utf8,
  type Edge,
  edgeFrom,
} from "./structures/core";
import { Volume, buildBlock, type Directory } from "./structures/volume";
import { Trie } from "./structures/trie";
const trieSource = (r: import("./flexbuffer").Reference) =>
  r.isMap() ? r : edgeFrom(r);
const seed = new Uint8Array(32).fill(42);
async function fixture() {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed });
  const one = await buildBlock(b, [[0n, utf8("one")]]),
    two = await buildBlock(b, [[0n, utf8("two")]]);
  const blocks: [string, typeof one][] = [
    ["/src/file", one],
    ["/src/nested/two", two],
    ["/src2/file", two],
    ["/target", two],
  ];
  const v = await Volume.fromBlocks(b, blocks, [
    "/src/empty",
    "/out",
    "/empty",
  ]);
  return { storage, b, blocks, one, two, v };
}
async function device(v: Volume, name: string): Promise<Edge> {
  const f = await v.stat(name);
  if (f.kind !== "file") throw Error("not file");
  return f.edge;
}

test("Volume mv/cp/rm coordinate hashes, empty directories and retained block identities", async () => {
  const { storage, b, blocks, one, two, v } = await fixture();
  const get = storage.get.bind(storage),
    fetched: string[] = [];
  storage.get = async (e) => {
    if (
      e[2] === ".sync-block/" ||
      (e[2] === ".trie-node/" && (e[6][1] as any)?.brombergSL2)
    )
      throw Error("unexpected file-body fetch");
    fetched.push(e[2]);
    return get(e);
  };
  const moved = await v.mv("/src", "/out/moved");
  const copied = await moved.cp("/out/moved", "/clone");
  const removed = await copied.rm("/out/moved", { recursive: true });
  const original = await v.stat("/src"),
    result = await removed.stat("/clone");
  expect(original.kind).toBe("directory");
  expect(result.kind).toBe("directory");
  expect((result as any).sha384).toEqual((original as any).sha384);
  expect(((await removed.stat("/")) as any).sha384).not.toEqual(
    ((await v.stat("/")) as any).sha384,
  );
  expect(await removed.list("/clone/empty")).toEqual([]);
  expect(await removed.list("/out")).toEqual([]);
  expect(await removed.list("/src2")).toEqual(["file"]);
  expect(await device(removed, "/clone/file")).toEqual(one.edge);
  expect(await device(v, "/src/file")).toEqual(one.edge);
  const canonical = await Volume.fromBlocks(
    b,
    [
      ["/clone/file", one],
      ["/clone/nested/two", two],
      ["/src2/file", two],
      ["/target", two],
    ],
    ["/clone/empty", "/out", "/empty"],
  );
  expect(removed.root[6].sha384).toEqual(canonical.root[6].sha384);
  expect(
    fetched.every((p) => p === ".sync-volume/" || p === ".trie-node/"),
  ).toBe(true);
  storage.get = get;
  const reload = new Volume(new Basin(storage, { seed }), removed.root);
  expect(await reload.read("/clone/file")).toEqual(utf8("one"));
  expect(await reload.read("/clone/nested/two")).toEqual(utf8("two"));
  expect(await v.read("/src/file")).toEqual(utf8("one"));
});

test("filesystem edits use exact destinations and explicit overwrite/recursive policies", async () => {
  const { v, one } = await fixture();
  expect(await v.mv("/src/file", "/src/file")).toBe(v);
  for (const [op, pattern] of [
    [() => v.mv("/missing", "/missing"), "missing"],
    [() => v.cp("/src", "/src"), "itself"],
    [() => v.mv("/src", "/src/nested/new"), "inside source"],
    [() => v.cp("/src", "/src/new"), "inside source"],
    [() => v.mv("/src", "/target"), "exists"],
    [() => v.mv("/src", "/target", { replace: true }), "collision"],
    [() => v.mv("/src", "/src2", { replace: true }), "not empty"],
    [() => v.mv("/src/file", "/missing/file"), "missing"],
    [() => v.mv("/src/file", "/target/file"), "directory"],
    [() => v.rm("/src"), "not empty"],
    [() => v.rm("/"), "pathname"],
    [() => v.mv("/", "/new"), "pathname"],
    [() => v.cp("/src/", "/new"), "pathname"],
  ] as const)
    await expect(op()).rejects.toThrow(pattern);
  const replaced = await v.cp("/src/file", "/target", { replace: true });
  expect(await device(replaced, "/target")).toEqual(one.edge);
  const renamedEmpty = await v.mv("/src/empty", "/empty", { replace: true });
  expect(await renamedEmpty.list("/empty")).toEqual([]);
  await expect(renamedEmpty.list("/src/empty")).rejects.toThrow("missing");
  const withoutEmpty = await v.rm("/src/empty");
  expect(await withoutEmpty.list("/src")).toEqual(["file", "nested"]);
  expect(await v.list("/src")).toEqual(["empty", "file", "nested"]);
});

test("concurrent volume operations isolate their roots and preserve Unicode/prototype basenames", async () => {
  const { v, b, one } = await fixture();
  const source = await Volume.fromBlocks(
    b,
    [
      ["/src/__proto__", one],
      ["/src/🦊", one],
    ],
    ["/src/empty"],
  );
  const [a, c] = await Promise.all([
    source.mv("/src", "/moved"),
    source.cp("/src", "/copied"),
  ]);
  expect(await a.list()).toEqual(["moved"]);
  expect(await c.list()).toEqual(["copied", "src"]);
  expect(await source.list()).toEqual(["src"]);
  expect(await a.read("/moved/__proto__")).toEqual(utf8("one"));
  expect(await c.read("/copied/🦊")).toEqual(utf8("one"));
});

test("prefix export recomputes full-key summaries and headers while retaining migration", async () => {
  const { TrieView } = await import("./structures/trie-view");
  const { hex } = await import("./structures/core");
  const consumer = {
    migration: 19,
    empty: [] as string[],
    entry: (k: Uint8Array, _v: number) => [hex(k)],
    combine: (s: readonly string[][]) => s.flat(),
  };
  const b = new Basin(new MemoryStorage(), { seed });
  const source = await Trie.build(
    b,
    [
      [utf8("/a/file"), 1],
      [utf8("/keep"), 2],
    ],
    consumer,
  );
  const moved = await (
    await TrieView.from(source).movePrefix(utf8("/a/"), utf8("/z/"))
  ).store();
  const expected = await Trie.build(
    b,
    [
      [utf8("/z/file"), 1],
      [utf8("/keep"), 2],
    ],
    consumer,
  );
  expect(moved.root[6].sha384).toEqual(expected.root[6].sha384);
  expect(moved.root[6][0]).toBe(19);
  expect(moved.root[6][1]).toEqual([hex(utf8("/keep")), hex(utf8("/z/file"))]);
  expect(moved.root[6][1]).not.toEqual(source.root[6][1]);
  expect((moved.root[5] as any).keys).toEqual([utf8("/keep"), utf8("/z/file")]);
  expect(await source.get(utf8("/a/file"))).toBe(1);
});
