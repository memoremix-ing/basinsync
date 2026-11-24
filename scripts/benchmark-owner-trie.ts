/** Fresh processes, matched scope boundaries, no concurrent heavy work. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
const out = Bun.env.OWNER_OUT ?? ".local/owner",
  rounds = Number(Bun.env.OWNER_ROUNDS ?? 5);
assert(Number.isInteger(rounds) && rounds > 0);
mkdirSync(out, { recursive: true });
const sources = [
  "tests/clients/subtree-cow-benchmark-worker.ts",
  "scripts/benchmark-owner-trie.ts",
  ...readdirSync("tests/clients/structures")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => "tests/clients/structures/" + f),
];
const hashes = Object.fromEntries(
  sources.map((p) => [
    p,
    createHash("sha384").update(readFileSync(p)).digest("hex"),
  ]),
);
const samples: any[] = [];
for (let round = 0; round < rounds; round++)
  for (const mode of ["scalar", "nested"])
    for (const api of ["core", "path", "proxy"])
      for (const batch of [1, 64, 1024]) {
        for (const mutation of round % 2
          ? ["owned", "persistent"]
          : ["persistent", "owned"]) {
          const style =
            api === "core"
              ? mutation === "owned"
                ? "raw-owned"
                : "persistent"
              : api;
          const p = Bun.spawn(
            ["bun", "tests/clients/subtree-cow-benchmark-worker.ts"],
            {
              stdout: "pipe",
              stderr: "pipe",
              env: {
                ...Bun.env,
                STRUCTURE_EXPERIMENT: mode,
                COW_STYLE: style,
                COW_MUTATION: mutation,
                COW_BATCH: String(batch),
              },
            },
          );
          const [stdout, stderr, code] = await Promise.all([
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
            p.exited,
          ]);
          assert.equal(code, 0, stderr);
          samples.push({ round, api, ...JSON.parse(stdout) });
          writeFileSync(
            out + "/runs.json",
            JSON.stringify(
              {
                runtime: Bun.version,
                cpu: cpus()[0].model,
                rounds,
                sources: hashes,
                samples,
              },
              null,
              2,
            ) + "\n",
          );
        }
        console.log(`round ${round + 1}: ${mode}/${api}/${batch}`);
      }
