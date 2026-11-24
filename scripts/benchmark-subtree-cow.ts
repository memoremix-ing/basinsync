/** Run client experiments sequentially; no concurrent heavy work during timings. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
const out = resolve(Bun.env.SUBTREE_COW_OUT ?? ".local/subtree-cow"),
  rounds = Number(Bun.env.SUBTREE_COW_ROUNDS ?? 5),
  n = Number(Bun.env.SUBTREE_COW_N ?? 100000);
assert(
  Number.isSafeInteger(n) &&
    n >= 6400 &&
    Number.isSafeInteger(rounds) &&
    rounds > 0,
  "use n >= 6400 and positive integer rounds",
);
mkdirSync(out, { recursive: true });
const modes = (Bun.env.SUBTREE_COW_MODES ?? "subtree,scalar,nested").split(","),
  samples: any[] = [];
const files = [
  "clients/subtree-cow-benchmark-worker.ts",
  ...readdirSync("clients/structures")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `clients/structures/${f}`),
  "clients/flexbuffer.ts",
  "clients/lexidecimal.ts",
  "clients/symbols.ts",
];
const hashes = Object.fromEntries(
  files.map((f) => [
    f,
    createHash("sha384").update(readFileSync(f)).digest("hex"),
  ]),
);
for (const mode of modes)
  for (let round = 0; round < rounds; round++) {
    const styles =
      mode === "subtree"
        ? ["enumerate", "handles", "lazy"]
        : mode === "scalar"
          ? ["persistent", "path", "proxy"]
          : ["persistent", "clone", "native", "path", "proxy"];
    if (round % 2) styles.reverse();
    for (const style of styles) {
      const p = Bun.spawn(["bun", "clients/subtree-cow-benchmark-worker.ts"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...Bun.env,
          STRUCTURE_EXPERIMENT: mode,
          COW_STYLE: style,
          STRUCTURE_N: String(n),
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      assert.equal(code, 0, stderr);
      const result = { round, ...JSON.parse(stdout) };
      if (mode === "subtree") {
        const prior = samples.find((s) => s.mode === mode);
        if (prior)
          assert.equal(
            result.output_sha384,
            prior.output_sha384,
            "identical exported root",
          );
      }
      samples.push(result);
      writeFileSync(
        `${out}/runs.json`,
        JSON.stringify(
          {
            bun: Bun.version,
            cpu: cpus()[0].model,
            recorded_at: new Date().toISOString(),
            source_sha384: hashes,
            samples,
          },
          null,
          2,
        ),
      );
      console.log(
        `${mode} ${style} ${round}: ${result.edit_ms.toFixed(2)}ms / ${((1000 * result.edit_ms) / result.operations).toFixed(3)}us per operation; export ${result.export_ms?.toFixed(1) ?? "n/a"}ms`,
      );
    }
  }
