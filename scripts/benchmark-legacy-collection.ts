// Read-only external source adapter; no changes to the historical checkout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpus, arch, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const source = process.argv[2] ?? Bun.env.LEGACY_COLLECTION;
assert(
  source,
  "usage: bun scripts/benchmark-legacy-collection.ts <collection.ts>",
);
const dir = resolve(
  Bun.env.COLLECTION_BENCH_OUT ?? `.local/collection-benchmark-${Date.now()}`,
);
const adapter = `${dir}/adapter`;
mkdirSync(adapter, { recursive: true });
const originals = [
  "collection.ts",
  "matter.ts",
  "change-management/change-management.ts",
  "result-types/result-types.ts",
];
const hashes: Record<string, string> = {};
const patches = [
  {
    from: "const ptr = asPointer(handle.pointer);",
    to: "const ptr = handle.pointer;",
    count: 1,
  },
  {
    from: "if (depth !== node.prefix)",
    to: "if (node.prefix !== -1 && depth !== node.prefix)",
    count: 4,
  },
];
for (const name of originals) {
  let text = readFileSync(resolve(dirname(source), name), "utf8");
  hashes[name] = createHash("sha384").update(text).digest("hex");
  if (name === "collection.ts")
    for (const p of patches) {
      assert.equal(
        text.split(p.from).length - 1,
        p.count,
        "historical source changed; inspect adapter",
      );
      text = text.replaceAll(p.from, p.to);
    }
  mkdirSync(dirname(`${adapter}/${name}`), { recursive: true });
  writeFileSync(`${adapter}/${name}`, text);
}
const rounds = Number(Bun.env.COLLECTION_BENCH_ROUNDS ?? 3);
assert(Number.isSafeInteger(rounds) && rounds > 0);
const sizes = Bun.env.TRIE_BENCH_SIZES ?? "1000,10000,100000";
const configurations = [
  {
    start: "0",
    layouts: "random,paths,clustered,lexidecimal,lexidecimal-shuffled",
  },
  {
    start: (1n << 200n).toString(),
    layouts: "lexidecimal,lexidecimal-shuffled",
  },
];
const samples: any[] = [];
const fixtureReports: any[] = [];
for (const config of configurations) {
  const fixtures = `${dir}/fixtures-${config.start}`;
  const generator = Bun.spawn(["bun", "clients/trie-benchmark.ts"], {
    env: {
      ...Bun.env,
      TRIE_BENCH_OUT: fixtures,
      TRIE_BENCH_IMPLS: "typescript",
      TRIE_BENCH_SIZES: sizes,
      TRIE_BENCH_LAYOUTS: config.layouts,
      TRIE_BENCH_LEX_START: config.start,
      TRIE_BENCH_ROUNDS: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(await generator.exited, 0, "fixture generation failed");
  fixtureReports.push(
    JSON.parse(readFileSync(`${fixtures}/report.json`, "utf8")),
  );
  for (const n of sizes.split(",").map(Number))
    for (const layout of config.layouts.split(",")) {
      const input = readFileSync(`${fixtures}/${layout}-${n}.json`, "utf8");
      for (let round = 0; round < rounds; round++) {
        for (const implementation of round % 2
          ? ["collection", "typescript"]
          : ["typescript", "collection"]) {
          const worker =
            implementation === "collection"
              ? "clients/legacy-collection-benchmark-worker.ts"
              : "clients/trie-benchmark-worker.ts";
          const child = Bun.spawn(["bun", worker], {
            env: { ...Bun.env, LEGACY_COLLECTION_ADAPTER: adapter },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          await child.stdin.write(input);
          await child.stdin.end();
          const [output, error, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          assert.equal(code, 0, error);
          const result = JSON.parse(output);
          assert.equal(result.implementation, implementation);
          for (const phase of [
            "build",
            "hot",
            "mixed",
            "miss",
            "sequential",
            "update1",
            "update100",
          ])
            assert(Number.isFinite(result[`${phase}_ms`]));
          samples.push({
            start: config.start,
            layout,
            n,
            round,
            ...result,
            resources: {
              maxRSS: child.resourceUsage()?.maxRSS,
              cpu_us: Number(child.resourceUsage()?.cpuTime.total),
            },
          });
          writeFileSync(
            `${dir}/samples.json`,
            JSON.stringify(samples, null, 2),
          );
          console.log(
            `${implementation} start=${config.start} ${layout} ${n} round ${round}: build ${result.build_ms.toFixed(1)}ms hot ${((result.hot_ms * 1000) / result.hot_ops).toFixed(3)}us`,
          );
        }
      }
    }
}
// Fingerprint every timed source, including the unmodified external dependencies.
const files = [
  "scripts/benchmark-legacy-collection.ts",
  "clients/legacy-collection-benchmark-worker.ts",
  "clients/trie-benchmark-worker.ts",
  "clients/trie-benchmark.ts",
  "clients/lexidecimal.ts",
  "clients/flexbuffer.ts",
  "clients/structures/core.ts",
  "clients/structures/trie.ts",
];
const report = {
  recorded_at: new Date().toISOString(),
  rounds,
  machine: {
    cpu: cpus()[0].model,
    cores: cpus().length,
    arch: arch(),
    platform: platform(),
    release: release(),
    memory: totalmem(),
  },
  bun: Bun.version,
  original_sha384: hashes,
  patches,
  source_sha384: Object.fromEntries(
    files.map((p) => [
      p,
      createHash("sha384").update(readFileSync(p)).digest("hex"),
    ]),
  ),
  fixture_source_sha384: fixtureReports[0].source_sha384,
  samples,
};
writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
console.log(`Artifacts: ${dir}`);
