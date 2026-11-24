/** Matched numeric positions: vector BigInts versus UTF-8 Lexidecimal map keys. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { encode } from "../tests/clients/lexidecimal";
const out = resolve(Bun.env.STRUCTURE_OUT ?? ".local/structure-comparison");
mkdirSync(out, { recursive: true });
const n = Number(Bun.env.STRUCTURE_N ?? 100000),
  rounds = Number(Bun.env.STRUCTURE_ROUNDS ?? 5);
assert(Number.isSafeInteger(n) && n >= 256 && rounds > 0);
const cases = (Bun.env.STRUCTURE_CASES ?? "dense,wide").split(",");
const tiers = (Bun.env.STRUCTURE_TIERS ?? "logical,serialized").split(",");
const adapter = resolve(
  Bun.env.TRIE_COST_COLLECTION_ADAPTER ?? ".local/collection-full/adapter",
);
const sourceFiles = [
  "tests/clients/structure-comparison-worker.ts",
  "tests/clients/structures/core.ts",
  "tests/clients/structures/trie.ts",
  "tests/clients/structures/vector.ts",
  "tests/clients/structures/packed.ts",
  "tests/clients/structures/operation.ts",
  "tests/clients/structures/logical-trie.ts",
  "tests/clients/structures/logical-vector.ts",
  "tests/clients/flexbuffer.ts",
  "tests/clients/lexidecimal.ts",
  "tests/clients/symbols.ts",
  ...[
    "collection.ts",
    "matter.ts",
    "change-management/change-management.ts",
    "result-types/result-types.ts",
  ].map((f) => `${adapter}/${f}`),
];
const sha384 = (s: string) => createHash("sha384").update(s).digest("hex");
const hashes = Object.fromEntries(
  sourceFiles.map((f) => [
    f.replace(adapter, "legacy-adapter"),
    sha384(readFileSync(f, "utf8")),
  ]),
);
const samples: any[] = [];
for (const layout of cases) {
  assert(["dense", "wide"].includes(layout));
  const start = layout === "dense" ? 0n : 1n << 200n;
  const entries = Array.from({ length: n }, (_, i) => [
    Buffer.from(encode(start + BigInt(i))).toString("hex"),
    i,
  ]);
  let seed = 42;
  const queries = Array.from({ length: 1024 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  });
  for (let round = 0; round < rounds; round++)
    for (const tier of tiers) {
      const kinds =
        tier === "logical"
          ? ["trie", "vector", "collection"]
          : ["trie", "vector"];
      if (round % 2) kinds.reverse();
      const input = JSON.stringify({
        start: String(start),
        entries,
        queries,
        sequential: Array.from({ length: 1024 }, (_, i) => i % n),
        warm: 8192,
        hot: tier === "logical" ? 262144 : 32768,
        cold: 128,
      });
      for (const kind of kinds) {
        const p = Bun.spawn(["bun", "tests/clients/structure-comparison-worker.ts"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...Bun.env,
            STRUCTURE_KIND: kind,
            STRUCTURE_TIER: tier,
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
              recorded_at: new Date().toISOString(),
              machine: {
                cpu: cpus()[0].model,
                platform: platform(),
                arch: arch(),
              },
              source_sha384: hashes,
              samples,
            },
            null,
            2,
          ),
        );
        console.log(
          `${layout} ${tier} ${kind} ${round}: build ${result.build_ms.toFixed(2)}ms; hot ${((1000 * result.hot_ms) / result.hot_ops).toFixed(3)}us; bytes ${result.stored_bytes ?? "n/a"}`,
        );
      }
    }
}
