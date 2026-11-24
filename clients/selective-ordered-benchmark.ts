import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Basin, MemoryStorage, utf8 } from "./structures/core";
import { Volume, buildBlock } from "./structures/volume";
import { BTree } from "./structures/btree";
import { plain } from "./structures/trie";
const OldVolume = (
  await import(Bun.env.VOLUME_BASELINE ?? "../.local/volume-full.ts")
).Volume;
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
        const original = await BTree.build(
            b,
            Array.from({ length: 100000 }, (_, i) => [
              i.toString(16).padStart(8, "0"),
              i,
            ]),
            plain,
          ),
          edit = (await original.edit()).set("00005ba0", -1);
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
          original = await Volume.fromBlocks(b, files),
          reader = new Basin(storage, { seed });
        const volume =
          mode === "full"
            ? new OldVolume(reader, original.root)
            : new Volume(reader, original.root);
        work = () => volume.update([["/d050/f1000", utf8("new")]]);
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
        result = await work(),
        ms = performance.now() - at;
      samples.push({
        trial,
        kind,
        mode,
        ms,
        gets: storage.reads,
        puts,
        newObjects: storage.objects.size - before,
        digest: Array.from(result.root[6].sha384).join(","),
      });
    }
for (const kind of ["btree", "directory"]) {
  const runs = samples.filter((s) => s.kind === kind);
  assert.equal(
    new Set(runs.map((r) => r.digest)).size,
    1,
    "canonical outputs differ",
  );
}
writeFileSync(
  ".local/selective-ordered.json",
  JSON.stringify(
    {
      runtime: Bun.version,
      method:
        "5 alternating trials; B-tree 100k entries, editor materialization excluded equally; directory 100 x 20 files, old full update versus selective update from cold reader; counts include storage adapter calls, not just new objects",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log("selective ordered measurements complete");
