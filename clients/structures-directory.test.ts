import { test, expect } from "bun:test";
import { Basin, MemoryStorage, utf8, type Edge } from "./structures/core";
import { Volume, buildBlock } from "./structures/volume";
const seed = new Uint8Array(32).fill(42);
test("wide directory metadata is paged and point reads avoid the full listing", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed }),
    blocks = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        buildBlock(b, [[0n, utf8("data" + i)]]),
      ),
    );
  const v = await Volume.fromBlocks(
    b,
    Array.from(
      { length: 5000 },
      (_, i) =>
        [`/wide/${i.toString(16).padStart(8, "0")}`, blocks[i >> 8]] as [
          string,
          (typeof blocks)[number],
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
  expect(await reader.read("/wide/000009c4")).toEqual(utf8("data9"));
  expect(bytes).toBeLessThan(
    [...storage.objects.values()].reduce((n, o) => n + o.bytes.length, 0) / 2,
  );
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
test("listed file edges load blocks without capability resolution", async () => {
  const storage = new MemoryStorage(),
    basin = new Basin(storage, { seed });
  const volume = await Volume.build(
    basin,
    Array.from(
      { length: 400 },
      (_, i) => [`/f${i}`, utf8(`file-${i}`)] as [string, Uint8Array],
    ),
  );
  const reader = new Volume(new Basin(storage, { seed }), volume.root);
  expect((await reader.list()).length).toBe(400);
  storage.resolve = async () => {
    throw Error("file edge required resolution");
  };
  const get = storage.get.bind(storage);
  storage.get = async (e) => {
    if (e[2] === ".trie-node/") throw Error("shortcut fetched an index");
    return get(e);
  };
  expect(await reader.read("/f250")).toEqual(utf8("file-250"));
});
test("directory export retains untouched subdirectories and matches a full canonical rebuild", async () => {
  const storage = new MemoryStorage(),
    writer = new Basin(storage, { seed }),
    block = await buildBlock(writer, [[0n, utf8("old")]]);
  const files = Array.from(
    { length: 2000 },
    (_, i) =>
      [
        `/d${Math.floor(i / 20)
          .toString()
          .padStart(3, "0")}/f${i}`,
        block,
      ] as [string, typeof block],
  );
  const original = await Volume.fromBlocks(writer, files);
  const reader = new Volume(new Basin(storage, { seed }), original.root);
  storage.reads = 0;
  const edited = await reader.update([["/d050/f1000", utf8("new")]]),
    reads = storage.reads;
  expect(reads).toBeLessThan(15);
  const newBlock = await buildBlock(writer, [[0n, utf8("new")]]);
  const canonical = await Volume.fromBlocks(
    writer,
    files.map(([n, b]) => [n, n === "/d050/f1000" ? newBlock : b]),
  );
  expect(edited.root[6].sha384).toEqual(canonical.root[6].sha384);
  expect(await edited.read("/d050/f1000")).toEqual(utf8("new"));
  expect(await reader.read("/d050/f1000")).toEqual(utf8("old"));
  const moved = await edited.mv("/d050", "/moved");
  expect(await moved.read("/moved/f1000")).toEqual(utf8("new"));
  expect(await moved.list("/d001")).toHaveLength(20);
});
test("blocks carry no link vector and preserve sparse page data", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed }),
    input = Array.from(
      { length: 5000 },
      (_, i) => [BigInt(i), new Uint8Array([i & 255])] as [bigint, Uint8Array],
    );
  const block = await buildBlock(b, input),
    volume = await Volume.fromBlocks(b, [["/file", block]]);
  for (const i of [0, 2500, 4999])
    expect(await volume.page("/file", BigInt(i))).toEqual(input[i][1]);
  expect(await volume.read("/file", { start: 2500 * 4096, length: 1 })).toEqual(
    input[2500][1],
  );
});
test("directory export repacks canonically when an edit crosses the inline budget", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed }),
    block = await buildBlock(b, [[0n, utf8("x")]]),
    files = Array.from(
      { length: 1260 },
      (_, i) =>
        [`/d${Math.floor(i / 63)}/f${i}`, block] as [string, typeof block],
    ),
    original = await Volume.fromBlocks(b, files);
  const changed = await original.update([["/d0/extra", utf8("y")]]),
    extra = await buildBlock(b, [[0n, utf8("y")]]),
    canonical = await Volume.fromBlocks(b, [...files, ["/d0/extra", extra]]);
  expect(changed.root[6].sha384).toEqual(canonical.root[6].sha384);
  const reverted = await changed.update([["/d0/extra", null]]);
  expect(reverted.root[6].sha384).toEqual(original.root[6].sha384);
});
test("nested directory costs stop at contents-trie edges and bound every stored node", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed }),
    block = await buildBlock(b, [[0n, utf8("x")]]),
    files = Array.from(
      { length: 2048 },
      (_, i) =>
        [
          `/d${Math.floor(i / 64)
            .toString()
            .padStart(3, "0")}/f${i % 64}`,
          block,
        ] as [string, typeof block],
    ),
    volume = await Volume.fromBlocks(b, files);
  const { object } = await import("./structures/core");
  const count = (n: any): number => {
    const group = (g: any) =>
      g.values.reduce(
        (sum: number, v: any) =>
          sum +
          1 +
          (Array.isArray(v) && v[0] === true && !Array.isArray(v[1].contents)
            ? count(v[1].contents)
            : 0),
        0,
      );
    let sum = group(n[6][2]);
    for (const m of n[6][3] ?? [])
      if (m) {
        if (Array.isArray(m)) {
          for (const ch of m) if (ch && !Array.isArray(ch)) sum += count(ch);
        } else sum += group(m);
      }
    return sum;
  };
  let metadataNodes = 0;
  for (const entry of storage.objects.values())
    if (entry.edge[2] === ".trie-node/" && entry.edge[6][1] === null) {
      const node = object<any>(await b.load(entry.edge));
      metadataNodes++;
      expect(count(node)).toBe((node[5] as any).inlined);
      expect(count(node)).toBeLessThanOrEqual(1280);
    }
  expect(metadataNodes).toBeGreaterThan(1);
  expect(await volume.list("/d031")).toHaveLength(64);
});
test("prefix-ending directory entries can externalize their contents under degree pressure", async () => {
  const b = new Basin(new MemoryStorage(), { seed }),
    blocks = [];
  for (let i = 0; i < 320; i++)
    blocks.push(await buildBlock(b, [[0n, new Uint8Array([i >> 8, i & 255])]]));
  const files: [string, (typeof blocks)[number]][] = [];
  for (let i = 0; i < 320; i++) files.push([`/a/f${i}`, blocks[i]]);
  for (let i = 0; i < 1000; i++) files.push([`/ab/f${i}`, blocks[i % 320]]);
  const volume = await Volume.fromBlocks(b, files);
  expect(volume.root[3].degree).toBeLessThanOrEqual(320);
  expect(await volume.read("/a/f319")).toEqual(new Uint8Array([1, 63]));
  expect(await volume.read("/ab/f999")).toEqual(new Uint8Array([0, 39]));
});
