import { sourceAt } from "./historical-source";
/** Ablations use isolated source snapshots; no integrity bypass enters production. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { cpus, platform, arch, totalmem } from "node:os";
const dir = resolve(Bun.env.TRIE_COST_OUT ?? `.local/trie-costs-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const baseRef = Bun.env.TRIE_COST_BASE_REF ?? "@-";
const files = [
  "tests/clients/flexbuffer.ts",
  "tests/clients/lexidecimal.ts",
  "tests/clients/symbols.ts",
  "tests/clients/structures/core.ts",
  "tests/clients/structures/trie.ts",
  "tests/clients/structures/types.ts",
  "tests/clients/structures/operation.ts",
];
const donorRef = Bun.env.TRIE_COST_DONOR_REF ?? "35e4d6ac";
const baseline: Record<string, string> = {},
  current: Record<string, string> = {};
for (const file of files) {
  const child = sourceAt(baseRef, file);
  assert(
    file.endsWith("/operation.ts") || child.exitCode === 0,
    child.stderr.toString(),
  );
  baseline[file] = file.endsWith("/operation.ts")
    ? readFileSync(file, "utf8")
    : child.stdout.toString();
  const donor = sourceAt(donorRef, file);
  assert.equal(donor.exitCode, 0, donor.stderr.toString());
  current[file] = donor.stdout.toString();
}
const cut = (text: string, a: string, b: string) =>
  text.slice(text.indexOf(a), text.indexOf(b, text.indexOf(a)));
const transplant = (text: string, donor: string, a: string, b: string) =>
  text.replace(cut(text, a, b), cut(donor, a, b));
const core = "tests/clients/structures/core.ts",
  trie = "tests/clients/structures/trie.ts",
  flex = "tests/clients/flexbuffer.ts";
const helper =
  '\nexport function isPromiseLike<T>(v:T|PromiseLike<T>): v is PromiseLike<T> { return v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as PromiseLike<T>).then === "function"; }\n';
// Reconstitute classic async control flow while retaining precisely the same lookup plans.
function classicAsync(source: string) {
  const begin = source.indexOf("  /** Does no I/O"),
    end = source.indexOf("  async *entries(", begin);
  assert(begin > 0 && end > begin);
  const seekStart = source.indexOf(
    "    for (;;) {",
    source.indexOf("  private seek("),
  );
  const seekEnd = source.indexOf("  getOrDefer(", seekStart);
  let loop = source.slice(seekStart, seekEnd);
  loop = loop.replace(
    /        const cached = this.basin.peek\(child.edge\);[\s\S]*?        r = cached;/,
    "        r = await this.basin.load(child.edge);",
  );
  const method = `  async getView(raw: Uint8Array | string): Promise<Reference | undefined> {
    let k = key(raw); const [header] = this.rootInfo();
    if (!header.keys || compare(k, header.keys[0]) < 0 || compare(k, header.keys[1]) > 0) return undefined;
    let r = await this.readRoot(), depth = 0;
${loop}
  async get(raw: Uint8Array | string): Promise<V | undefined> {
    const r = await this.getView(raw); return r === undefined ? undefined : object<V>(r);
  }
`;
  return source.slice(0, begin) + method + source.slice(end);
}
const variants: Record<string, Record<string, string>> = {};
for (const name of [
  "baseline",
  "prototype",
  "callbacks",
  "metadata",
  "lookup",
  "store-index",
  "combined",
  "combined-index",
  "combined-sync",
  "native-crypto",
  "logical-baseline",
  "logical-callbacks",
  "logical-final",
  "hex",
  "combined-hex",
  "combined-final",
  "collection",
]) {
  const s = { ...baseline };
  if (
    [
      "prototype",
      "combined",
      "combined-index",
      "combined-sync",
      "combined-hex",
      "combined-final",
    ].includes(name)
  )
    s[flex] = current[flex];
  if (
    [
      "metadata",
      "combined",
      "combined-index",
      "combined-sync",
      "combined-hex",
      "combined-final",
    ].includes(name)
  )
    s[core] = current[core];
  if (
    [
      "lookup",
      "combined",
      "combined-index",
      "combined-sync",
      "combined-hex",
      "combined-final",
    ].includes(name)
  )
    s[trie] = current[trie];
  if (["lookup", "combined", "combined-index"].includes(name))
    s[trie] = classicAsync(s[trie]);
  if (name === "lookup") {
    s[trie] = transplant(
      s[trie],
      baseline[trie],
      "  static async buildNode",
      "  private parts(",
    );
    s[core] += helper;
  }
  if (["callbacks", "logical-callbacks", "logical-final"].includes(name)) {
    s[trie] = transplant(
      s[trie],
      current[trie],
      "  static async buildNode",
      "  private parts(",
    ).replace("  u32,\n", "  u32,\n  isPromiseLike,\n");
    s[core] += helper;
  }
  if (["store-index", "combined-index", "combined-final"].includes(name))
    s[core] = transplant(
      s[core],
      current[core],
      "export class MemoryStorage",
      "export interface Options",
    );
  else if (
    ["metadata", "combined", "combined-sync", "combined-hex"].includes(name)
  )
    s[core] = transplant(
      s[core],
      baseline[core],
      "export class MemoryStorage",
      "export interface Options",
    );
  s[core] = transplant(
    s[core],
    ["hex", "combined-hex", "combined-final", "logical-final"].includes(name)
      ? current[core]
      : baseline[core],
    "export function hex(",
    "export function key(",
  );
  if (name === "native-crypto") {
    const start = s[core].indexOf("export async function sha384("),
      end = s[core].indexOf("/** RFC 5869", start);
    s[core] =
      s[core].slice(0, start) +
      `export async function sha384(b: Uint8Array): Promise<Uint8Array> { return new Uint8Array(new Bun.CryptoHasher("sha384").update(b).digest()); }\nexport async function hmac(k: Uint8Array,b: Uint8Array): Promise<Uint8Array> { return new Uint8Array(new Bun.CryptoHasher("sha384", k).update(b).digest()); }\n` +
      s[core].slice(end);
  }
  // Keep the current wire schema constant across historical algorithm variants.
  s[trie] = s[trie]
    .replace(/\b63\b/g, "255")
    .replace(
      "        reversals: bounds(\n          input.map((r) => r.key.slice().reverse()),\n          compare,\n        ),\n",
      "",
    );
  variants[name] = s;
  for (const [file, text] of Object.entries(s)) {
    const dest = `${dir}/${name}/${file}`;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
}
const names = (
  Bun.env.TRIE_COST_VARIANTS ?? Object.keys(variants).join(",")
).split(",");
assert(names.every((n) => variants[n]));
const rounds = Number(Bun.env.TRIE_COST_ROUNDS ?? 3),
  n = Number(Bun.env.TRIE_COST_N ?? 100000);
assert(Number.isSafeInteger(rounds) && rounds > 0);
const layouts = (Bun.env.TRIE_COST_LAYOUTS ?? "random,lexidecimal").split(",");
const fixtureDir = resolve(
  Bun.env.TRIE_COST_FIXTURES ?? ".local/trie-lex-zero",
);
const samples: any[] = [];
for (const layout of layouts) {
  const input = readFileSync(`${fixtureDir}/${layout}-${n}.json`, "utf8");
  for (let round = 0; round < rounds; round++) {
    const offset = round % names.length,
      order = [...names.slice(offset), ...names.slice(0, offset)];
    for (const variant of order) {
      const child = Bun.spawn(["bun", "tests/clients/trie-cost-worker.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...Bun.env,
          TRIE_COST_SOURCE: `${dir}/${variant}`,
          TRIE_COST_LOGICAL: variant.startsWith("logical-") ? "1" : "0",
          TRIE_COST_COLLECTION: variant === "collection" ? "1" : "0",
          TRIE_COST_ROUND: String(round),
        },
      });
      await child.stdin.write(input);
      await child.stdin.end();
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, `${variant}: ${error}`);
      const result = JSON.parse(output);
      const prior = samples.find((s) => s.layout === layout && s.root_sha384);
      if (result.root_sha384 && prior)
        assert.equal(
          result.root_sha384,
          prior.root_sha384,
          `canonical root ${variant}`,
        );
      samples.push({ variant, layout, n, round, ...result });
      writeFileSync(`${dir}/samples.json`, JSON.stringify(samples, null, 2));
      console.log(
        `${variant} ${layout} ${n} round ${round}: build ${result.build_ms.toFixed(1)}ms hot ${((result.hot_ms * 1000) / result.hot_ops).toFixed(2)}us`,
      );
    }
  }
}
const hash = (s: string) => createHash("sha384").update(s).digest("hex");
const report = {
  recorded_at: new Date().toISOString(),
  base_ref: baseRef,
  donor_ref: donorRef,
  base_commit: Bun.spawnSync([
    "jj",
    "log",
    "--no-graph",
    "-r",
    baseRef,
    "-T",
    "commit_id",
  ]).stdout.toString(),
  rounds,
  n,
  bun: Bun.version,
  machine: {
    cpu: cpus()[0].model,
    platform: platform(),
    arch: arch(),
    memory: totalmem(),
  },
  schema_normalization: "255-entry groups; no base reversal bounds",
  baseline_sha384: Object.fromEntries(files.map((f) => [f, hash(baseline[f])])),
  variant_sha384: Object.fromEntries(
    names.map((v) => [
      v,
      Object.fromEntries(files.map((f) => [f, hash(variants[v][f])])),
    ]),
  ),
  worker_sha384: hash(readFileSync("tests/clients/trie-cost-worker.ts", "utf8")),
  samples,
};
writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
console.log(`Artifacts: ${dir}`);
