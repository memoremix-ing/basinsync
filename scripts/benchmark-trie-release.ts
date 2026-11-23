/** Compare checked-in TypeScript implementations, keeping fixture/API work identical. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { cpus, arch, platform } from "node:os";
const baseRef = Bun.env.TRIE_RELEASE_BASE_REF ?? "35e4d6ac";
const root = resolve(
  Bun.env.TRIE_RELEASE_OUT ?? `.local/trie-release-${Date.now()}`,
);
const fixtures = resolve(
  Bun.env.TRIE_RELEASE_FIXTURES ?? ".local/trie-lex-zero",
);
const rounds = Number(Bun.env.TRIE_RELEASE_ROUNDS ?? 5),
  n = Number(Bun.env.TRIE_RELEASE_N ?? 100000);
assert(Number.isSafeInteger(rounds) && rounds > 0);
const tiers = (
  Bun.env.TRIE_RELEASE_TIERS ?? "logical-build,serialized-api"
).split(",");
assert(
  tiers.every((t) => ["logical-build", "serialized-api"].includes(t)),
  "unknown tier",
);
const hot =
  Bun.env.TRIE_RELEASE_HOT === undefined
    ? undefined
    : Number(Bun.env.TRIE_RELEASE_HOT);
assert(
  hot === undefined || (Number.isSafeInteger(hot) && hot > 0),
  "invalid hot read count",
);
const layouts = (Bun.env.TRIE_RELEASE_LAYOUTS ?? "random,lexidecimal").split(
  ",",
);
const files = [
  "clients/structures/core.ts",
  "clients/structures/trie.ts",
  "clients/structures/types.ts",
  "clients/structures/operation.ts",
  "clients/flexbuffer.ts",
  "clients/lexidecimal.ts",
  "clients/symbols.ts",
];
const versions = ["baseline", "optimized"];
const hashes: Record<string, Record<string, string>> = {};
const hash = (s: string) => createHash("sha384").update(s).digest("hex");
for (const version of versions) {
  hashes[version] = {};
  for (const file of [
    ...files,
    "clients/trie-cost-worker.ts",
    "clients/trie-benchmark-worker.ts",
  ]) {
    let source: string;
    if (version === "baseline" && files.includes(file)) {
      const p = Bun.spawnSync(["jj", "file", "show", "-r", baseRef, file]);
      assert.equal(p.exitCode, 0, p.stderr.toString());
      source = p.stdout.toString();
    } else source = readFileSync(file, "utf8");
    const target = `${root}/${version}/${file}`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    hashes[version][file] = hash(source);
  }
}
const samples: any[] = [],
  fixtureHashes: Record<string, string> = {};
for (const layout of layouts) {
  let input = readFileSync(`${fixtures}/${layout}-${n}.json`, "utf8");
  if (hot !== undefined) input = JSON.stringify({ ...JSON.parse(input), hot });
  fixtureHashes[layout] = hash(input);
  for (let round = 0; round < rounds; round++)
    for (const tier of tiers)
      for (const version of round % 2 ? versions.toReversed() : versions) {
        const worker =
          tier === "logical-build"
            ? "trie-cost-worker"
            : "trie-benchmark-worker";
        const p = Bun.spawn(
          ["bun", `${root}/${version}/clients/${worker}.ts`],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...Bun.env,
              TRIE_COST_SOURCE: `${root}/${version}`,
              TRIE_COST_LOGICAL: "1",
              TRIE_COST_COLLECTION: "0",
              TRIE_COST_PROFILE: "0",
            },
          },
        );
        await p.stdin.write(input);
        await p.stdin.end();
        const [out, error, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        assert.equal(code, 0, error);
        const result = JSON.parse(out);
        const kept =
          tier === "logical-build"
            ? {
                build_ms: result.build_ms,
                validated_entries: n,
                reader:
                  "unchanged logical control; not timed for release comparison",
              }
            : result;
        if (tier === "serialized-api") {
          const prior = samples.find(
            (s) => s.tier === tier && s.layout === layout,
          );
          if (prior)
            for (const field of [
              "root_sha384",
              "objects",
              "stored_bytes",
              "height",
              "prefix_count",
              "hot_reads",
              "cold_reads",
              "sequential_reads",
            ])
              assert.equal(result[field], prior[field], `unchanged ${field}`);
        }
        samples.push({ tier, version, layout, n, round, ...kept });
        writeFileSync(`${root}/samples.json`, JSON.stringify(samples, null, 2));
        console.log(
          `${tier} ${version} ${layout} ${round}: build ${result.build_ms.toFixed(1)}ms${tier === "serialized-api" ? `, get ${((result.hot_ms * 1000) / result.hot_ops).toFixed(3)}us` : ""}`,
        );
      }
}
writeFileSync(
  `${root}/report.json`,
  JSON.stringify(
    {
      recorded_at: new Date().toISOString(),
      base_ref: baseRef,
      hot_override: hot,
      tiers,
      rounds,
      n,
      bun: Bun.version,
      machine: { cpu: cpus()[0].model, arch: arch(), platform: platform() },
      source_sha384: hashes,
      fixture_sha384: fixtureHashes,
      samples,
    },
    null,
    2,
  ),
);
console.log(`Artifacts: ${root}`);
