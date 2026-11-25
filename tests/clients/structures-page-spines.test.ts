import { test, expect } from "bun:test";
import {
  Basin,
  MemoryStorage,
  type Storage,
  type Node,
  object,
  capability,
  link,
  utf8,
} from "./structures/core";
import { Volume, buildBlock, type PageLink } from "./structures/volume";
const seed = new Uint8Array(32).fill(42);
test("page spines skip stored levels near a boundary and authenticate their targets", async () => {
  const storage = new MemoryStorage(),
    writer = new Basin(storage, { seed, maxDegree: 32 }),
    pages = Array.from(
      { length: 50000 },
      (_, i) =>
        [
          65536n + BigInt(i),
          new Uint8Array([
            i >>> 24,
            (i >>> 16) & 255,
            (i >>> 8) & 255,
            i & 255,
          ]),
        ] as [bigint, Uint8Array],
    ),
    block = await buildBlock(writer, pages),
    volume = await Volume.fromBlocks(writer, [["/file", block]]);
  const body = object<Node>(await writer.load(block.edge)),
    leading = body[6][3] as Array<PageLink | null>;
  expect(leading.filter(Boolean).length).toBeGreaterThan(1);
  for (let h = 0; h < leading.length; h++)
    if (leading[h]) {
      const hint = leading[h]!,
        edge = await storage.resolve(hint.link);
      expect(hint.link.height).toBe(h);
      expect(edge?.[2]).toBe(".trie-node/");
      expect(edge?.[6].sha384).toEqual(hint.sha384);
    }
  const counts: number[] = [];
  for (const shortcuts of [false, true]) {
    let gets = 0;
    const adapter: Storage = {
      put: storage.put.bind(storage),
      get: async (e) => {
        gets++;
        return storage.get(e);
      },
      resolve: storage.resolve.bind(storage),
    };
    const reader = new Volume(
      new Basin(adapter, { seed, maxDegree: 32 }),
      volume.root,
    );
    expect(await reader.page("/file", 65536n, shortcuts)).toEqual(pages[0][1]);
    counts.push(gets);
    const before = gets;
    expect(await reader.page("/file", 65537n, shortcuts)).toEqual(pages[1][1]);
    expect(gets).toBe(before);
  }
  expect(counts[1]).toBeLessThan(counts[0]);
  for (const hint of leading) if (hint) hint.sha384 = new Uint8Array(48);
  body[6][4] = [{}];
  const refs = storage.objects.get(capability(link(block.edge)))!.edges;
  const changed = {
      edge: await writer.seal(body, [...refs]),
      digest: block.digest,
    },
    badVolume = await Volume.fromBlocks(writer, [["/file", changed]]);
  expect(
    await new Volume(
      new Basin(storage, { seed, maxDegree: 32 }),
      badVolume.root,
    ).page("/file", 65536n),
  ).toEqual(pages[0][1]);
});
test("directory tuples retain file blocks through contents tries", async () => {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed }),
    block = await buildBlock(b, [[0n, utf8("x")]]),
    volume = await Volume.fromBlocks(b, [["/d/file", block]], ["/empty"]),
    node = object<Node>(await b.load(volume.root));
  expect(node[6].length).toBe(3);
  const directory = node[6][2] as unknown[];
  expect(Array.isArray(directory)).toBe(true);
  expect(directory.length).toBe(5);
  expect(directory[0]).toBe(true);
  expect(directory[1]).toBeInstanceOf(Uint8Array);
  const reachable = new Set<string>();
  const visit = (e: typeof block.edge) => {
    const id = capability(link(e));
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const child of storage.objects.get(id)!.edges) visit(child);
  };
  visit(volume.root);
  expect(reachable.has(capability(link(block.edge)))).toBe(true);
  expect(
    [...storage.objects.values()].some(
      (o) => o.edge[2] === ".sync-directory/" || o.edge[2] === ".vector-node/",
    ),
  ).toBe(false);
  expect(await volume.stat("/d/file")).toEqual({
    kind: "file",
    crc64nvme: block.digest,
    edge: block.edge,
  });
});
