/** Request/byte counts only; tiny pages isolate routing, not realistic transfer timing. */
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  Basin,
  MemoryStorage,
  utf8,
  type Edge,
  type Storage,
} from "./structures/core";
import { Volume, buildBlock } from "./structures/volume";
const seed = new Uint8Array(32).fill(42),
  samples: any[] = [];
async function trace(
  storage: MemoryStorage,
  root: Edge,
  path: string,
  page: number,
  shortcuts: boolean,
  expected: number,
) {
  let gets = 0,
    bytes = 0,
    resolves = 0;
  const bySpecies: Record<string, number> = {};
  const adapter: Storage = {
    put: (...args) => storage.put(...args),
    get: async (e) => {
      const data = await storage.get(e);
      gets++;
      bytes += data.length;
      bySpecies[e[2]] = (bySpecies[e[2]] ?? 0) + 1;
      return data;
    },
    resolve: async (l) => {
      resolves++;
      return storage.resolve(l);
    },
  };
  const volume = new Volume(new Basin(adapter, { seed }), root);
  assert.deepEqual(
    await volume.read(path, { start: page * 4096, length: 1, shortcuts }),
    new Uint8Array([expected]),
  );
  const cold = { gets, bytes, resolves, bySpecies: { ...bySpecies } };
  assert.deepEqual(
    await volume.read(path, { start: page * 4096, length: 1, shortcuts }),
    new Uint8Array([expected]),
  );
  return {
    ...cold,
    warmGets: gets - cold.gets,
    warmBytes: bytes - cold.bytes,
    warmResolves: resolves - cold.resolves,
  };
}
for (const n of [20000, 350000]) {
  const storage = new MemoryStorage(),
    b = new Basin(storage, { seed });
  const block = await buildBlock(
    b,
    Array.from(
      { length: n },
      (_, i) => [BigInt(i), new Uint8Array([i & 255])] as [bigint, Uint8Array],
    ),
  );
  const v = await Volume.fromBlocks(b, [["/file", block]]);
  for (const page of [0, Math.floor(n / 2), n - 1])
    for (const shortcuts of [false, true])
      samples.push({
        fixture: "pages",
        n,
        page,
        shortcuts,
        ...(await trace(storage, v.root, "/file", page, shortcuts, page & 255)),
      });
  console.error(`traced ${n} pages`);
}
{
  const n = 5000,
    storage = new MemoryStorage(),
    b = new Basin(storage, { seed });
  const block = await buildBlock(b, [[0n, new Uint8Array([42])]]);
  const name = (i: number) => `/files/${i.toString(16).padStart(8, "0")}`;
  const v = await Volume.fromBlocks(
    b,
    Array.from(
      { length: n },
      (_, i) => [name(i), block] as [string, typeof block],
    ),
  );
  for (const file of [0, Math.floor(n / 2), n - 1])
    for (const shortcuts of [false, true])
      samples.push({
        fixture: "files",
        n,
        file,
        shortcuts,
        ...(await trace(storage, v.root, name(file), 0, shortcuts, 42)),
      });
}
const sources = [
  "tests/clients/volume-shortcut-trace.ts",
  ...readdirSync("tests/clients/structures")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `tests/clients/structures/${f}`),
  "tests/clients/flexbuffer.ts",
];
const result = {
  runtime: Bun.version,
  method:
    "cold Basin cache per case; one-byte pages; in-memory zero-I/O capability resolver; warm repeat of same read; counters only",
  sources: Object.fromEntries(
    sources.map((p) => [
      p,
      createHash("sha384").update(readFileSync(p)).digest("hex"),
    ]),
  ),
  samples,
};
const out = Bun.env.VOLUME_TRACE_OUT ?? ".local/volume-shortcut-trace.json";
mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(samples, null, 2));
