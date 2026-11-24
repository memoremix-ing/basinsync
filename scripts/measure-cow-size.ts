/** Full browser ESM profiles; source counts include comments/blank lines. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import ts from "typescript";
const out = resolve(".local/subtree-cow/sizes");
mkdirSync(out, { recursive: true });
const module = (f: string) =>
  JSON.stringify(resolve(`tests/clients/structures/${f}.ts`));
const base = `export {Basin,MemoryStorage} from ${module("core")}; export {Trie,TrieEditor} from ${module("trie")};`;
const entries = {
  base,
  view: base + `export {TrieView} from ${module("trie-view")};`,
  explicit: base + `export {produceTrie} from ${module("cow")};`,
  proxy:
    base +
    `export {produceTrieProxy,ReadonlyCowBytes} from ${module("cow-proxy")};`,
  all:
    base +
    `export {TrieView} from ${module("trie-view")};export {produceTrie} from ${module("cow")};export {produceTrieProxy,ReadonlyCowBytes} from ${module("cow-proxy")};`,
};
const source = Object.fromEntries(
  ["logical-trie", "trie-view", "cow", "cow-values", "cow-proxy"].map(
    (name) => {
      const text = readFileSync(`tests/clients/structures/${name}.ts`, "utf8"),
        ast = ts.createSourceFile(
          name + ".ts",
          text,
          ts.ScriptTarget.Latest,
          true,
        );
      let functions = 0,
        branches = 0;
      const scan = (n: ts.Node) => {
        if (
          ts.isFunctionDeclaration(n) ||
          ts.isArrowFunction(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isFunctionExpression(n)
        )
          functions++;
        if (
          ts.isIfStatement(n) ||
          ts.isConditionalExpression(n) ||
          ts.isForStatement(n) ||
          ts.isForOfStatement(n) ||
          ts.isWhileStatement(n) ||
          ts.isCatchClause(n) ||
          ts.isSwitchStatement(n)
        )
          branches++;
        ts.forEachChild(n, scan);
      };
      scan(ast);
      return [
        name,
        {
          lines: text.trimEnd().split("\n").length,
          bytes: Buffer.byteLength(text),
          functions,
          branch_loop_sites: branches,
        },
      ];
    },
  ),
);
const bundles: Record<string, any> = {};
for (const [name, text] of Object.entries(entries)) {
  const path = `${out}/${name}.ts`;
  writeFileSync(path, text);
  const item: any = {};
  for (const minify of [false, true]) {
    const built = await Bun.build({
      entrypoints: [path],
      target: "browser",
      format: "esm",
      minify,
      sourcemap: "none",
    });
    assert(built.success, built.logs.map(String).join("\n"));
    assert.equal(built.outputs.length, 1);
    const js = await built.outputs[0].text(),
      buf = Buffer.from(js);
    writeFileSync(`${out}/${name}${minify ? ".min" : ""}.js`, buf);
    if (minify)
      Object.assign(item, {
        min_bytes: buf.length,
        gzip_bytes: gzipSync(buf, { level: 9 }).length,
      });
    else
      Object.assign(item, {
        lines: js.trimEnd().split("\n").length,
        bytes: buf.length,
      });
    const exports = await import(`${out}/${name}${minify ? ".min" : ""}.js`);
    assert(exports.TrieEditor);
  }
  bundles[name] = item;
}
writeFileSync(
  `${out}/report.json`,
  JSON.stringify({ bun: Bun.version, source, bundles }, null, 2),
);
console.log(JSON.stringify({ source, bundles }, null, 2));
