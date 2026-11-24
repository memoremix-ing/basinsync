import { test, expect } from "bun:test";
import { Basin, MemoryStorage, utf8, type Edge } from "./structures/core";
import { Volume, buildBlock } from "./structures/volume";
const seed = new Uint8Array(32).fill(42);
test("wide directory metadata is paged and point reads avoid the full listing", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed }),
    block = await buildBlock(b, [[0n, utf8("x")]]);
  const v = await Volume.fromBlocks(
    b,
    Array.from(
      { length: 5000 },
      (_, i) =>
        [`/wide/${i.toString(16).padStart(8, "0")}`, block] as [
          string,
          typeof block,
        ],
    ),
  );
  let bytes = 0;
  const get = storage.get.bind(storage);
  storage.get = async (e) => {
    const d = await get(e);
    bytes += d.length;
    return d;
  };
  storage.reads = 0;
  const reader = new Volume(new Basin(storage, { seed }), v.root);
  expect(await reader.read("/wide/000009c4")).toEqual(utf8("x"));
  expect(bytes).toBeLessThan(300000);
  expect(storage.reads).toBeLessThan(8);
  const names = await reader.list("/wide");
  expect(names.length).toBe(5000);
  expect(names[2500]).toBe("000009c4");
});
test("deep directory metadata spills without losing empty directories", async () => {
  const b = new Basin(new MemoryStorage(), { seed }),
    path = "/" + Array.from({ length: 80 }, (_, i) => "d" + i).join("/");
  const v = await Volume.build(
    b,
    [[path + "/file", utf8("ok")]],
    [path + "/empty"],
  );
  expect(v.root[3].height).toBeGreaterThan(0);
  expect(await v.read(path + "/file")).toEqual(utf8("ok"));
  expect(await v.list(path + "/empty")).toEqual([]);
});
test("volume updates read metadata but no unchanged file or sector bodies", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed });
  const v = await Volume.build(
    b,
    [
      ["/keep", utf8("keep")],
      ["/change", utf8("old")],
    ],
    ["/empty"],
  );
  const get = storage.get.bind(storage);
  storage.get = async (e) => {
    if (
      e[2] === ".sync-block/" ||
      (e[2] === ".trie-node/" && (e[6][1] as any)?.brombergSL2)
    )
      throw Error("unchanged body fetched");
    return get(e);
  };
  const updated = await v.update([
    ["/change", utf8("new")],
    ["/added", utf8("more")],
  ]);
  storage.get = get;
  expect(await updated.read("/keep")).toEqual(utf8("keep"));
  expect(await updated.read("/change")).toEqual(utf8("new"));
  expect(await updated.list("/empty")).toEqual([]);
  expect(await v.read("/change")).toEqual(utf8("old"));
});
