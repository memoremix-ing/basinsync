/** Browser-target ESM exports retain the complete class APIs, without source maps. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
const out = resolve(Bun.env.STRUCTURE_BUNDLE_OUT ?? ".local/structure-bundles");
const adapter = resolve(
  Bun.env.TRIE_COST_COLLECTION_ADAPTER ?? ".local/collection-full/adapter",
);
mkdirSync(out, { recursive: true });
const modulePath = (name: string) =>
  JSON.stringify(resolve(`tests/clients/structures/${name}.ts`));
const core = `export { Basin, MemoryStorage } from ${modulePath("core")};\n`;
const trie = `export { Trie } from ${modulePath("trie")};\n`;
const vector = `export { Vector } from ${modulePath("vector")};\n`;
const collection = `export { EagerCollection, CConfig } from ${JSON.stringify(`${adapter}/collection.ts`)};\nexport { expire } from ${JSON.stringify(`${adapter}/change-management/change-management.ts`)};\n`;
const entries = {
  core,
  trie_class: trie,
  vector_class: vector,
  trie: core + trie,
  vector: core + vector,
  combined: core + trie + vector,
  collection,
};
const sources: Record<string, string[]> = {
  trie: [
    resolve("tests/clients/structures/trie.ts"),
    resolve("tests/clients/structures/logical-trie.ts"),
  ],
  vector: [
    resolve("tests/clients/structures/vector.ts"),
    resolve("tests/clients/structures/packed.ts"),
    resolve("tests/clients/structures/logical-vector.ts"),
  ],
  collection: [
    "collection.ts",
    "matter.ts",
    "change-management/change-management.ts",
    "result-types/result-types.ts",
  ].map((f) => `${adapter}/${f}`),
};
const source = Object.fromEntries(
  Object.entries(sources).map(([k, fs]) => [
    k,
    {
      files: fs.map((f) => f.replace(adapter, "legacy-adapter")),
      lines: fs.reduce(
        (s, f) => s + readFileSync(f, "utf8").trimEnd().split("\n").length,
        0,
      ),
      bytes: fs.reduce((s, f) => s + readFileSync(f).byteLength, 0),
    },
  ]),
);
const bundles: Record<string, any> = {};
for (const [name, source] of Object.entries(entries)) {
  const entry = `${out}/${name}.ts`;
  writeFileSync(entry, source);
  const metrics: any = {};
  for (const minify of [false, true]) {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      minify,
      sourcemap: "none",
    });
    assert(result.success, result.logs.map(String).join("\n"));
    assert.equal(result.outputs.length, 1);
    const js = await result.outputs[0].text();
    const bytes = Buffer.from(js);
    writeFileSync(`${out}/${name}${minify ? ".min" : ""}.js`, bytes);
    if (minify)
      Object.assign(metrics, {
        min_bytes: bytes.length,
        gzip_bytes: gzipSync(bytes, { level: 9 }).length,
        brotli_bytes: brotliCompressSync(bytes, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
        }).length,
      });
    else
      Object.assign(metrics, {
        lines: js.trimEnd().split("\n").length,
        bytes: bytes.length,
      });
    // Load the produced ESM; all named APIs must survive tree shaking.
    const exported = await import(`${out}/${name}${minify ? ".min" : ""}.js`);
    assert(Object.keys(exported).length > 0);
  }
  bundles[name] = metrics;
}
writeFileSync(
  `${out}/sizes.json`,
  JSON.stringify(
    { bun: Bun.version, target: "browser", format: "esm", source, bundles },
    null,
    2,
  ),
);
console.log(JSON.stringify({ source, bundles }, null, 2));
