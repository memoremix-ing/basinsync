import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { cpus, arch, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { encode as lex } from "./lexidecimal";
import { hex, utf8, compare } from "./structures/core";
const sizes = (Bun.env.TRIE_BENCH_SIZES ?? "1000,10000,100000")
    .split(",")
    .map(Number),
  layouts = (
    Bun.env.TRIE_BENCH_LAYOUTS ?? "random,paths,clustered,lexidecimal"
  ).split(","),
  rounds = Number(Bun.env.TRIE_BENCH_ROUNDS ?? 3);
assert(
  sizes.every((n) => Number.isSafeInteger(n) && n >= 256 && n <= 0xffffffff),
  "sizes must be integers between 256 and 2^32-1",
);
assert(
  layouts.every((n) =>
    [
      "random",
      "paths",
      "clustered",
      "lexidecimal",
      "lexidecimal-shuffled",
    ].includes(n),
  ),
  "unknown layout",
);
const lexStart = BigInt(Bun.env.TRIE_BENCH_LEX_START ?? "0");
assert(lexStart >= 0n, "Lexidecimal start must be nonnegative");
assert(Number.isSafeInteger(rounds) && rounds > 0, "rounds must be positive");
const label = Bun.env.TRIE_BENCH_LABEL ?? "current",
  dir = resolve(
    Bun.env.TRIE_BENCH_OUT ?? `.local/trie-benchmark-${label}-${Date.now()}`,
  );
mkdirSync(dir, { recursive: true });
const implementations = (
    Bun.env.TRIE_BENCH_IMPLS ?? "typescript,rust,go"
  ).split(","),
  samples: any[] = [];
function dataset(layout: string, n: number) {
  assert(n >= 256);
  let state = 42;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const rows: [Uint8Array, number][] = [];
  for (let i = 0; i < n; i++) {
    let k: Uint8Array;
    if (layout.startsWith("lexidecimal")) k = utf8(lex(lexStart + BigInt(i)));
    else if (layout === "paths")
      k = utf8(
        `/work/projects/p-${String(i >> 7).padStart(5, "0")}/file-${String(i).padStart(7, "0")}.dat`,
      );
    else {
      k = new Uint8Array(layout === "clustered" ? 36 : 16);
      const view = new DataView(k.buffer);
      if (layout === "clustered") k.fill(97, 0, 32);
      else
        for (let at = 0; at < 12; at += 4) view.setUint32(at, random(), false);
      view.setUint32(k.length - 4, i, false);
    }
    rows.push([k, i]);
  }
  const prefix = layout.startsWith("lexidecimal")
      ? utf8(lex(lexStart + 16n).slice(0, -1))
      : layout === "paths"
        ? utf8("/work/projects/p-00000/")
        : rows[0][0].slice(0, layout === "random" ? 1 : 35),
    prefix_count = rows.filter(([k]) =>
      prefix.every((v, i) => k[i] === v),
    ).length;
  if (layout.startsWith("lexidecimal"))
    for (let i = 1; i < n; i++)
      assert(
        compare(rows[i - 1][0], rows[i][0]) < 0,
        "Lexidecimal order mismatch",
      );
  if (layout !== "lexidecimal")
    for (let i = n - 1; i > 0; i--) {
      const j = random() % (i + 1);
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
  const byValue = new Map(rows.map(([, v], i) => [v, i]));
  return {
    entries: rows.map(([k, v]) => [hex(k), v]),
    queries: Array.from({ length: 1024 }, (_, i) =>
      layout.startsWith("lexidecimal")
        ? byValue.get((i * 2654435761) % n)!
        : (i * 2654435761) % n,
    ),
    sequential: Array.from(
      { length: Math.min(n, 1024) },
      (_, i) => byValue.get(i)!,
    ),
    hot: 4096,
    cold: 128,
    prefix: hex(prefix),
    prefix_count,
  };
}
function version(cmd: string[]) {
  const p = Bun.spawnSync(cmd);
  assert.equal(p.exitCode, 0);
  return new TextDecoder().decode(p.stdout).trim();
}
for (const n of sizes)
  for (const layout of layouts) {
    const data = dataset(layout, n),
      input = JSON.stringify(data);
    writeFileSync(`${dir}/${layout}-${n}.json`, input);
    for (let round = 0; round < rounds; round++) {
      const order = [
        ...implementations.slice(round % implementations.length),
        ...implementations.slice(0, round % implementations.length),
      ];
      for (const implementation of order) {
        const command =
          implementation === "typescript"
            ? ["bun", "tests/clients/trie-benchmark-worker.ts"]
            : implementation === "rust"
              ? ["target/release/examples/benchmark"]
              : [".local/trie-benchmark-go"];
        const child = Bun.spawn(command, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...Bun.env },
        });
        await child.stdin.write(input);
        await child.stdin.end();
        const [text, error, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        assert.equal(code, 0, error);
        const result = JSON.parse(text);
        assert.equal(result.implementation, implementation);
        for (const name of [
          "build",
          "hot",
          "mixed",
          "miss",
          "cold",
          "sequential",
          "scan",
          "prefix",
          "pruned",
          "update1",
          "update100",
        ])
          assert(Number.isFinite(result[`${name}_ms`]));
        assert.match(
          result.root_sha384,
          /^[0-9a-f]{96}$/,
          "worker is missing root digest instrumentation; rebuild it",
        );
        const prior = samples.find(
          (s) =>
            s.n === n &&
            s.implementation === implementation &&
            (s.layout === layout ||
              (s.layout.startsWith("lexidecimal") &&
                layout.startsWith("lexidecimal"))),
        );
        if (prior)
          for (const field of [
            "root_sha384",
            "objects",
            "stored_bytes",
            "height",
            "prefix_count",
          ])
            assert.equal(
              result[field],
              prior[field],
              `canonical ${field}: ${layout}/${implementation}/${n}`,
            );
        assert.equal(result.hot_reads, 0, "hot working set did not fit cache");
        assert.equal(result.pruned_reads, 0);
        samples.push({
          label,
          layout,
          n,
          round,
          ...result,
          resources: {
            maxRSS: child.resourceUsage()?.maxRSS,
            cpu_us: Number(child.resourceUsage()?.cpuTime.total),
          },
        });
        writeFileSync(`${dir}/samples.json`, JSON.stringify(samples, null, 2));
        console.log(
          `${label} ${layout} ${n} ${implementation} round ${round}: build ${result.build_ms.toFixed(1)}ms, hot ${((result.hot_ms * 1000) / result.hot_ops).toFixed(1)}us/op`,
        );
      }
    }
  }
const sourceFiles = [
  "tests/clients/lexidecimal.ts",
  "tests/clients/trie-benchmark.ts",
  "tests/clients/flexbuffer.ts",
  "tests/clients/structures/core.ts",
  "tests/clients/structures/trie.ts",
  "crates/structures/src/basin.rs",
  "crates/structures/src/value.rs",
  "crates/structures/src/trie.rs",
  "go/structures/basin.go",
  "go/structures/wire.go",
  "go/structures/trie.go",
];
const report = {
  benchmark_version: 2,
  source_sha384: Object.fromEntries(
    sourceFiles.map((path) => [
      path,
      createHash("sha384").update(readFileSync(path)).digest("hex"),
    ]),
  ),
  label,
  lexidecimal_start: lexStart.toString(),
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
  versions: {
    bun: version(["bun", "--version"]),
    rust: version(["rustc", "--version"]),
    go: version(["go", "version"]),
  },
  samples,
};
writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
console.log(`Artifacts: ${dir}`);
