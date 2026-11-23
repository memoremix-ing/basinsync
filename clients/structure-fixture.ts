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
import { Volume, buildBlock } from "./structures/volume";
import { parse, stringify } from "./json0";
export type Archive = {
  kind: "trie" | "volume" | "pages";
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
  kind: "trie" | "volume" | "pages";
  seed: Uint8Array;
  entries?: [string, unknown][];
  files?: [string, Uint8Array][];
  directories?: string[];
  pages?: [bigint, Uint8Array][];
  queries?: bigint[];
}): Promise<Archive> {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed: input.seed });
  const root =
    input.kind === "trie"
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
  let rows: [string, unknown][] = [];
  if (a.kind === "trie") {
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
