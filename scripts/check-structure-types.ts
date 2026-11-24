import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const root = "docs/diy/0zg6/261120-basin-node-stdlib";
const files = [
  "stdlib.d.ts",
  "0zg7/261120-byte-trie/trie.d.ts",
  "0zg7/261123-bitmapped-vector-trie/vector.d.ts",
  "0zg7/261123-b-tree/btree.d.ts",
];
const declarations = files
  .map((file) => readFileSync(`${root}/${file}`, "utf8"))
  .join("\n");
function tokens(text: string) {
  const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      text,
    ),
    out: [number, string][] = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    if (
      kind !== ts.SyntaxKind.ExportKeyword &&
      kind !== ts.SyntaxKind.CommaToken
    )
      out.push([kind, scanner.getTokenText()]);
  }
  return out;
}
assert.deepEqual(
  tokens(readFileSync("clients/structures/types.ts", "utf8")),
  tokens(declarations),
  "public declarations differ from documented schemas",
);
console.log("Documented and public structure declarations agree");
