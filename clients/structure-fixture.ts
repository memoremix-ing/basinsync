import {
  Basin,
  MemoryStorage,
  key,
  hex,
  nodeKey,
  link,
  type Edge,
} from "./structures/core";
import { Trie, Consumer } from "./structures/trie";
import { Vector } from "./structures/vector";
import { BTree } from "./structures/btree";
import { Volume, buildBlock } from "./structures/volume";
import { parse, stringify } from "./json0";
export type Archive = {
  kind: "trie" | "volume" | "pages" | "vector" | "btree";
  root: Edge;
  objects: [Edge, Uint8Array][];
  queries?: bigint[];
};
export const count: Consumer<unknown, bigint> = {
  migration: 7,
  empty: 0n,
  entry: () => 1n,
  combine: (xs) => xs.reduce((a, b) => a + b, 0n),
};
export async function build(input: {
  kind: "trie" | "volume" | "pages" | "vector" | "btree";
  seed: Uint8Array;
  entries?: [string, unknown][];
  files?: [string, Uint8Array][];
  directories?: string[];
  pages?: [bigint, Uint8Array][];
  items?: [bigint, unknown][];
  length?: bigint;
  bits?: number;
  queries?: bigint[];
}): Promise<Archive> {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed: input.seed });
  const root =
    input.kind === "vector"
      ? (
          await Vector.buildEntries(b, input.length!, input.items!, count, {
            bits: input.bits,
          })
        ).root
      : input.kind === "btree"
        ? (await BTree.build(b, input.entries!, count)).root
        : input.kind === "trie"
          ? (await Trie.build(b, input.entries!, count)).root
          : input.kind === "pages"
            ? (
                await Volume.fromBlocks(b, [
                  ["/sparse", await buildBlock(b, input.pages!)],
                ])
              ).root
            : (await Volume.build(b, input.files!, input.directories)).root;
  return {
    kind: input.kind,
    queries: input.queries,
    root,
    objects: [...storage.objects.values()].map((v) => [v.edge, v.bytes]),
  };
}
export async function verify(a: Archive) {
  const storage = new MemoryStorage();
  for (const [e, b] of a.objects) await storage.restore(e, b);
  const basin = new Basin(storage, { seed: new Uint8Array(32).fill(42) });
  let rows: any[] = [];
  let probes: any[] | undefined;
  if (a.kind === "vector") {
    const vector = new Vector(basin, a.root, count);
    for await (const row of vector.entries()) rows.push(row);
    probes = [];
    for (const i of a.queries ?? []) {
      const v = await vector.get(i);
      probes.push([i, v !== undefined, v ?? null]);
    }
  } else if (a.kind === "btree") {
    const tree = new BTree(basin, a.root, count);
    for await (const [k, v] of tree.entries()) rows.push([hex(k), v]);
  } else if (a.kind === "trie") {
    for await (const [k, v] of new Trie(basin, a.root, count).entries())
      rows.push([hex(k), v]);
  } else if (a.kind === "pages") {
    const volume = new Volume(basin, a.root);
    for (const page of a.queries!)
      rows.push([
        page as unknown as string,
        (await volume.page("/sparse", page)) ?? null,
      ]);
  } else {
    const volume = new Volume(basin, a.root);
    const walk = async (prefix: string) => {
      for (const name of await volume.list(prefix)) {
        const p = prefix === "/" ? `/${name}` : `${prefix}/${name}`;
        let directory = false;
        try {
          await volume.list(p);
          directory = true;
        } catch {}
        if (directory) {
          rows.push([p, null]);
          await walk(p);
        } else {
          const weak = await volume.read(p),
            strong = await volume.read(p, { shortcuts: false });
          if (hex(weak) !== hex(strong)) throw Error("shortcut mismatch");
          rows.push([p, weak]);
        }
      }
    };
    await walk("/");
  }
  return {
    kind: a.kind,
    ...(probes ? { probes } : {}),
    rows,
    query: a.root[3],
    header: a.root[5],
    keys: (
      await Promise.all(a.objects.map(([e]) => nodeKey(link(e), "old")))
    ).sort(),
  };
}
if (import.meta.main) {
  const mode = process.argv[2],
    input = parse<any>(await Bun.stdin.text());
  process.stdout.write(
    stringify(mode === "build" ? await build(input) : await verify(input)),
  );
}
