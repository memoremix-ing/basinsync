import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Basin, MemoryStorage, utf8 } from "./structures/core";
import { Volume, buildBlock } from "./structures/volume";
import { BTree } from "./structures/btree";
import { plain } from "./structures/trie";
const seed = new Uint8Array(32).fill(42),
  samples: any[] = [];
for (let trial = 0; trial < 5; trial++)
  for (const kind of ["btree", "directory"])
    for (const mode of trial % 2
      ? ["selective", "full"]
      : ["full", "selective"]) {
      const storage = new MemoryStorage(),
        b = new Basin(storage, { seed });
      let work: () => Promise<any>;
      if (kind === "btree") {
        const tree = await BTree.build(
            b,
            Array.from({ length: 100000 }, (_, i) => [
              i.toString(16).padStart(8, "0"),
              i,
            ]),
            plain,
          ),
          edit = (await tree.edit()).set("00005ba0", -1);
        work = () =>
          mode === "full"
            ? BTree.build(b, edit.entries(), plain)
            : edit.store();
      } else {
        const block = await buildBlock(b, [[0n, utf8("old")]]),
          files = Array.from(
            { length: 2000 },
            (_, i) =>
              [
                `/d${Math.floor(i / 20)
                  .toString()
                  .padStart(3, "0")}/f${i}`,
                block,
              ] as [string, typeof block],
          ),
          root = await Volume.fromBlocks(b, files),
          reader = new Basin(storage, { seed }),
          volume = new Volume(reader, root.root);
        work = async () => {
          if (mode !== "full")
            return volume.update([["/d050/f1000", utf8("new")]]);
          const blocks: [string, typeof block][] = [],
            dirs: string[] = [];
          const walk = async (p: string) => {
            for (const n of await volume.list(p)) {
              const name = p === "/" ? "/" + n : p + "/" + n,
                s = await volume.stat(name);
              if (s.kind === "directory") {
                dirs.push(name);
                await walk(name);
              } else
                blocks.push([name, { edge: s.edge, digest: s.brombergSL2 }]);
            }
          };
          await walk("/");
          const replacement = await buildBlock(reader, [[0n, utf8("new")]]);
          return Volume.fromBlocks(
            reader,
            blocks.map(([p, b]) => [p, p === "/d050/f1000" ? replacement : b]),
            dirs,
          );
        };
      }
      let puts = 0;
      const put = storage.put.bind(storage);
      storage.put = async (...args) => {
        puts++;
        return put(...args);
      };
      storage.reads = 0;
      const before = storage.objects.size,
        at = performance.now(),
        result = await work();
      samples.push({
        trial,
        kind,
        mode,
        ms: performance.now() - at,
        gets: storage.reads,
        puts,
        newObjects: storage.objects.size - before,
        digest: Array.from(result.root[6].sha384).join(","),
      });
    }
for (const kind of ["btree", "directory"])
  assert.equal(
    new Set(samples.filter((s) => s.kind === kind).map((s) => s.digest)).size,
    1,
    "canonical outputs differ",
  );
writeFileSync(
  ".local/selective-ordered.json",
  JSON.stringify(
    {
      runtime: Bun.version,
      method:
        "five alternating trials; B-tree editor loading excluded equally; directory full enumeration/rebuild versus selective edit on current descriptor layout; counts include adapter calls",
      samples,
    },
    null,
    2,
  ) + "\n",
);
