/** Matched logical-only capability splits and implementation ablations. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { cpus, arch, platform } from "node:os";
import { variantSources } from "./trie-logic-variants";
const suites = {
  construction: [
    "baseline",
    "endpoints",
    "partition",
    "endpoints-partition",
    "offset-reader",
    "no-cuts",
    "no-cuts-offset",
  ],
  readers: [
    "baseline",
    "hoisted-find",
    "manual-prefix",
    "offset-only",
    "offset-combined",
    "collection",
  ],
  capabilities: [
    "baseline",
    "headers-off",
    "consumer-off",
    "metadata-off",
    "optimized",
    "optimized-headers-off",
    "optimized-consumer-off",
    "optimized-metadata-off",
    "collection",
  ],
};
const suite = Bun.env.TRIE_LOGIC_SUITE ?? "construction";
assert(suite in suites, "unknown suite");
const names = (
  Bun.env.TRIE_LOGIC_VARIANTS ??
  suites[suite as keyof typeof suites]
    .filter((v) => v !== "collection" || Bun.env.TRIE_COST_COLLECTION_ADAPTER)
    .join(",")
).split(",");
assert(
  names.every((n) => suites[suite as keyof typeof suites].includes(n)),
  "unknown variant",
);
const rounds = Number(Bun.env.TRIE_LOGIC_ROUNDS ?? 5),
  n = Number(Bun.env.TRIE_LOGIC_N ?? 100000);
assert(Number.isSafeInteger(rounds) && rounds > 0);
const layouts = (Bun.env.TRIE_LOGIC_LAYOUTS ?? "random,lexidecimal").split(",");
const root = resolve(
    Bun.env.TRIE_LOGIC_OUT ?? `.local/trie-logic-${suite}-${Date.now()}`,
  ),
  fixtures = resolve(Bun.env.TRIE_LOGIC_FIXTURES ?? ".local/trie-lex-zero");
const paths = [
  "clients/structures/core.ts",
  "clients/structures/trie.ts",
  "clients/structures/types.ts",
  "clients/structures/operation.ts",
  "clients/lexidecimal.ts",
  "clients/flexbuffer.ts",
  "clients/symbols.ts",
];
// Freeze the pre-promotion sources so named ablations retain their original meaning.
const baseRef = Bun.env.TRIE_LOGIC_BASE_REF ?? "35e4d6ac";
const base = Object.fromEntries(
  paths.map((p) => {
    const child = Bun.spawnSync(["jj", "file", "show", "-r", baseRef, p]);
    assert.equal(child.exitCode, 0, child.stderr.toString());
    return [p, child.stdout.toString()];
  }),
);
const worker = readFileSync("clients/trie-cost-worker.ts", "utf8"),
  sources: Record<string, Record<string, string>> = {};
for (const name of names) {
  const variant = variantSources(
    base["clients/structures/trie.ts"],
    worker,
    name,
  );
  const files = {
    ...base,
    "clients/structures/trie.ts": variant.trie,
    "worker.ts": variant.worker,
  };
  sources[name] = files;
  for (const [p, s] of Object.entries(files)) {
    const target = `${root}/${name}/${p}`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, s);
  }
}
const samples: any[] = [],
  fixtureHashes: Record<string, string> = {};
const hash = (s: string) => createHash("sha384").update(s).digest("hex");
for (const layout of layouts) {
  const input = readFileSync(`${fixtures}/${layout}-${n}.json`, "utf8");
  fixtureHashes[layout] = hash(input);
  for (let round = 0; round < rounds; round++)
    for (const name of [
      ...names.slice(round % names.length),
      ...names.slice(0, round % names.length),
    ]) {
      const child = Bun.spawn(["bun", `${root}/${name}/worker.ts`], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...Bun.env,
          TRIE_COST_SOURCE: `${root}/${name}`,
          TRIE_COST_LOGICAL: "1",
          TRIE_COST_COLLECTION: name === "collection" ? "1" : "0",
        },
      });
      await child.stdin.write(input);
      await child.stdin.end();
      const [out, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, `${name}: ${error}`);
      const result = { variant: name, layout, n, round, ...JSON.parse(out) };
      samples.push(result);
      writeFileSync(`${root}/samples.json`, JSON.stringify(samples, null, 2));
      console.log(
        `${name} ${layout} ${round}: build ${result.build_ms.toFixed(1)}ms, get ${((result.logical_direct_ms * 1000) / result.logical_ops).toFixed(3)}us`,
      );
    }
}
writeFileSync(
  `${root}/report.json`,
  JSON.stringify(
    {
      recorded_at: new Date().toISOString(),
      suite,
      base_ref: baseRef,
      rounds,
      entries: n,
      bun: Bun.version,
      machine: { cpu: cpus()[0].model, arch: arch(), platform: platform() },
      fixture_sha384: fixtureHashes,
      source_sha384: Object.fromEntries(
        Object.entries(sources).map(([v, files]) => [
          v,
          Object.fromEntries(
            Object.entries(files).map(([p, s]) => [p, hash(s)]),
          ),
        ]),
      ),
      samples,
    },
    null,
    2,
  ),
);
console.log(`Artifacts: ${root}`);
