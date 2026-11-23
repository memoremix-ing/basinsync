/** Run frozen vector controls in fresh processes; all serialized roots must agree. */
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { encode } from "../clients/lexidecimal";
const root = resolve(Bun.env.VECTOR_PASS_ROOT ?? ".local/vector-pass"),
  rounds = Number(Bun.env.VECTOR_PASS_ROUNDS ?? 3),
  n = Number(Bun.env.VECTOR_PASS_N ?? 100000);
const variants = (
    Bun.env.VECTOR_PASS_VARIANTS ??
    "baseline,parsed,sync,digits,partition,builder"
  ).split(","),
  samples: any[] = [],
  hashes: Record<string, any> = {};
// Freeze current dependencies and reconstruct the historical controls on a fresh run.
// Existing snapshots remain untouched so fingerprints continue to describe measured code.
const vectorPath = "clients/structures/vector.ts";
if (variants.some((v) => !existsSync(`${root}/${v}/${vectorPath}`))) {
  const ref = Bun.env.VECTOR_PASS_BASE_REF ?? "c7ef9501";
  const prior = Bun.spawnSync(["jj", "file", "show", "-r", ref, vectorPath]);
  assert.equal(prior.exitCode, 0, prior.stderr.toString());
  const baseline = prior.stdout.toString(),
    current = readFileSync(vectorPath, "utf8");
  const replace = (s: string, a: string, b: string) => {
    assert(s.includes(a), `control anchor missing: ${a}`);
    return s.replace(a, b);
  };
  const plan = current.slice(
    current.indexOf("  private readonly plans"),
    current.indexOf("  getViewOrDefer("),
  );
  let parsed =
    baseline.slice(0, baseline.indexOf("  private parts(")) +
    plan +
    baseline.slice(baseline.indexOf("  async getView("));
  parsed = replace(
    parsed,
    "const { h, bitmap, slots } = this.parts(r);",
    "const p = this.parts(r), { h, bitmap, slots } = p;",
  );
  parsed = replace(
    parsed,
    "r = at.isMap() ? at : await this.basin.load(edgeFrom(at));",
    `let child = p.children.get(slot);
      if (!child) { child = at.isMap() ? at : edgeFrom(at); p.children.set(slot, child); }
      r = Array.isArray(child) ? await this.basin.load(child) : child;`,
  );
  const getters = current.slice(
    current.indexOf("  getViewOrDefer("),
    current.indexOf("  async *entries("),
  );
  const prefix =
    'import { type Operation, resolveOperation } from "./operation";\n';
  const withGetters = (g: string) =>
    prefix +
    parsed.slice(0, parsed.indexOf("  async getView(")) +
    g +
    parsed.slice(parsed.indexOf("  async *entries("));
  let syncGetters = getters
    .replace(/    const digits: number \| string =[\s\S]*?;\n/, "")
    .replaceAll("digits", "i")
    .replaceAll("number | string", "bigint");
  syncGetters = syncGetters.replace(
    /      const position = h.shift \/ 5;[\s\S]*?      if \(!has/,
    "      const slot = Number((i >> BigInt(h.shift)) & 31n);\n      if (!has",
  );
  assert(!syncGetters.includes("const position"));
  const digits = withGetters(getters),
    sync = withGetters(syncGetters);
  const partition = replace(
    digits,
    `      for (let slot = 0; slot < 32; slot++) {
        const lo = base + BigInt(slot) * width,
          at = part.filter((r) => r.index >= lo && r.index < lo + width);`,
    `      let position = 0;
      for (let slot = 0; slot < 32; slot++) {
        const lo = base + BigInt(slot) * width, end = lo + width, begin = position;
        while (position < part.length && part[position].index < end) position++;
        const at = part.slice(begin, position);`,
  );
  const controls: Record<string, string> = {
    baseline,
    parsed,
    sync,
    digits,
    partition,
    builder: current,
  };
  const files = [
    "clients/structure-comparison-worker.ts",
    "clients/flexbuffer.ts",
    "clients/lexidecimal.ts",
    "clients/symbols.ts",
    ...readdirSync("clients/structures")
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `clients/structures/${f}`),
  ];
  for (const variant of variants) {
    assert(controls[variant], "unknown vector control");
    if (existsSync(`${root}/${variant}/${vectorPath}`)) continue;
    mkdirSync(`${root}/${variant}/clients/structures`, { recursive: true });
    for (const file of files)
      writeFileSync(
        `${root}/${variant}/${file}`,
        file === vectorPath ? controls[variant] : readFileSync(file),
      );
  }
}
for (const v of variants) {
  const base = `${root}/${v}`;
  const files = [
    "clients/structure-comparison-worker.ts",
    ...readdirSync(`${base}/clients/structures`)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `clients/structures/${f}`),
    "clients/flexbuffer.ts",
    "clients/lexidecimal.ts",
    "clients/symbols.ts",
  ];
  hashes[v] = Object.fromEntries(
    files.map((f) => [
      f,
      createHash("sha384")
        .update(readFileSync(`${base}/${f}`))
        .digest("hex"),
    ]),
  );
}
for (const layout of ["dense", "wide"]) {
  const start = layout === "dense" ? 0n : 1n << 200n;
  let seed = 42;
  const input = JSON.stringify({
    start: String(start),
    entries: Array.from({ length: n }, (_, i) => [
      Buffer.from(encode(start + BigInt(i))).toString("hex"),
      i,
    ]),
    queries: Array.from({ length: 1024 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    }),
    sequential: Array.from({ length: 1024 }, (_, i) => i % n),
    hot: 32768,
    warm: 8192,
    cold: 128,
  });
  for (let round = 0; round < rounds; round++)
    for (const variant of round % 2 ? variants.toReversed() : variants) {
      const p = Bun.spawn(
        ["bun", `${root}/${variant}/clients/structure-comparison-worker.ts`],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...Bun.env,
            STRUCTURE_KIND: "vector",
            STRUCTURE_TIER: "serialized",
          },
        },
      );
      await p.stdin.write(input);
      await p.stdin.end();
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      assert.equal(code, 0, err);
      const result = JSON.parse(out),
        prior = samples.find((s) => s.layout === layout);
      if (prior)
        for (const f of [
          "root_sha384",
          "objects",
          "stored_bytes",
          "height",
          "cold_reads",
          "sequential_reads",
        ])
          assert.equal(result[f], prior[f], `${variant}: unchanged ${f}`);
      samples.push({ variant, layout, round, n, ...result });
      writeFileSync(
        `${root}/ablation.json`,
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
        `${layout} ${variant} ${round}: ${result.build_ms.toFixed(1)}ms / ${((1000 * result.hot_ms) / result.hot_ops).toFixed(3)}us`,
      );
    }
}
