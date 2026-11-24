/** Incremental logical operations; canonical export and full rebuild are separate phases. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { encode } from "../tests/clients/lexidecimal";
const out = resolve(Bun.env.STRUCTURE_EDIT_OUT ?? ".local/structure-edits"),
  adapter = resolve(
    Bun.env.TRIE_COST_COLLECTION_ADAPTER ?? ".local/collection-full/adapter",
  );
mkdirSync(out, { recursive: true });
const n = Number(Bun.env.STRUCTURE_EDIT_N ?? 100000),
  rounds = Number(Bun.env.STRUCTURE_EDIT_ROUNDS ?? 5),
  samples: any[] = [];
const files = [
  "tests/clients/structure-edit-worker.ts",
  "tests/clients/structures/trie.ts",
  "tests/clients/structures/vector.ts",
  "tests/clients/structures/logical-trie.ts",
  "tests/clients/structures/logical-vector.ts",
  "tests/clients/structures/core.ts",
  "tests/clients/structures/packed.ts",
  "tests/clients/flexbuffer.ts",
  "tests/clients/lexidecimal.ts",
  "tests/clients/structures/operation.ts",
  "tests/clients/symbols.ts",
  ...[
    "collection.ts",
    "matter.ts",
    "change-management/change-management.ts",
    "result-types/result-types.ts",
  ].map((f) => `${adapter}/${f}`),
];
const hashes = Object.fromEntries(
  files.map((f) => [
    f.replace(adapter, "legacy-adapter"),
    createHash("sha384").update(readFileSync(f)).digest("hex"),
  ]),
);
for (const layout of ["dense", "wide"]) {
  const start = layout === "dense" ? 0n : 1n << 200n;
  let seed = 42;
  const edits = 4096;
  const input = JSON.stringify({
    start: String(start),
    entries: Array.from({ length: n }, (_, i) => [
      Buffer.from(encode(start + BigInt(i))).toString("hex"),
      i,
    ]),
    appended: Array.from({ length: edits }, (_, i) =>
      Buffer.from(encode(start + BigInt(n + i))).toString("hex"),
    ),
    queries: Array.from({ length: 1024 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    }),
    edits,
    rebuilds: 8,
    hot: 262144,
  });
  for (let round = 0; round < rounds; round++)
    for (const kind of round % 2
      ? ["collection", "vector", "trie"]
      : ["trie", "vector", "collection"]) {
      const p = Bun.spawn(["bun", "tests/clients/structure-edit-worker.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...Bun.env,
          STRUCTURE_KIND: kind,
          TRIE_COST_COLLECTION_ADAPTER: adapter,
        },
      });
      await p.stdin.write(input);
      await p.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      assert.equal(code, 0, stderr);
      const result = { layout, n, round, ...JSON.parse(stdout) };
      samples.push(result);
      writeFileSync(
        `${out}/runs.json`,
        JSON.stringify(
          {
            bun: Bun.version,
            cpu: cpus()[0].model,
            source_sha384: hashes,
            samples,
          },
          null,
          2,
        ),
      );
      console.log(
        `${layout} ${kind} ${round}: build ${result.build_ms.toFixed(1)}ms; snapshot edit ${((1000 * result.snapshot_edits_ms) / result.edit_ops).toFixed(3)}us; append ${((1000 * result.append_ms) / result.edit_ops).toFixed(3)}us`,
      );
    }
}
