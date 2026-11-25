import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const root = "docs/diy/0zg6/261120-basin-node-stdlib";
const files = [
  "stdlib.d.ts",
  "0zg8/261125-prolly-page-storage/prolly.d.ts",
  "0zg8/261125-prolly-page-storage/prolly-file.d.ts",
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
function schemas(text: string) {
  const source = ts.createSourceFile("schemas.ts", text, ts.ScriptTarget.Latest, true);
  const found = new Map<string, ReturnType<typeof tokens>>();
  for (const statement of source.statements) {
    assert(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
      "schemas contain only named type/interface declarations");
    const name = statement.name.text;
    assert(!found.has(name), `duplicate schema ${name}`);
    found.set(name, tokens(statement.getText(source)));
  }
  return [...found].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
assert.deepEqual(
  schemas(readFileSync("tests/clients/structures/types.ts", "utf8")),
  schemas(declarations),
  "public declarations differ from documented schemas",
);
console.log("Documented and public structure declarations agree");
