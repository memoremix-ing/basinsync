import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const folder="docs/diy/0zg6/261120-trie";
const declarations=readFileSync(`${folder}/trie.d.ts`,"utf8");
const discussion=readFileSync(`${folder}/README.md`,"utf8");
assert.equal([...discussion.matchAll(/```ts\n([\s\S]*?)```/g)].map(m=>m[1]).join(""),declarations,"discussion declarations differ from trie.d.ts");
function tokens(text:string){const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,text),out:[number,string][]=[];for(let kind=scanner.scan();kind!==ts.SyntaxKind.EndOfFileToken;kind=scanner.scan()){if(kind!==ts.SyntaxKind.ExportKeyword&&kind!==ts.SyntaxKind.CommaToken)out.push([kind,scanner.getTokenText()]);}return out;}
assert.deepEqual(tokens(readFileSync("clients/structures/types.ts","utf8")),tokens(declarations),"public declarations differ from documented schema");
console.log("Documented and public structure declarations agree");
