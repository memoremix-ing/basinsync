// Read-only compatibility probe: never change the historical source checkout.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
const argument = process.argv[2] ?? Bun.env.LEGACY_DICTIONARY;
if (!argument)
  throw Error("usage: bun scripts/probe-legacy-dictionary.ts <dictionary.ts>");
const source = resolve(argument),
  text = readFileSync(source, "utf8"),
  folder = resolve(".local/legacy-dictionary-probe");
mkdirSync(folder, { recursive: true });
const result: any = {
  source,
  sha384: createHash("sha384").update(text).digest("hex"),
  direct: null,
  core: null,
};
try {
  await import(source);
  result.direct = "imported";
} catch (e) {
  result.direct = String(e);
}
// Remove only the unrelated top-level SAUTable demonstration; expose the existing
// non-exported mutator without implementing or substituting any dictionary logic.
const begin = text.indexOf("new SAUTable().openWindow("),
  end = text.indexOf("// event=", begin);
if (begin < 0 || end < 0)
  throw Error("unrecognized legacy demo; inspect before adapting");
const adapted =
  (text.slice(0, begin) + text.slice(end)).replace(
    /from "\.\/(.*?)"/g,
    (_, p) => `from ${JSON.stringify(`${dirname(source)}/${p}`)}`,
  ) + "\nexport {dSet as benchmarkSet};\n";
const path = `${folder}/dictionary.ts`;
writeFileSync(path, adapted);
try {
  const { benchmarkSet, DConfig } = await import(path);
  benchmarkSet(new DConfig(), [new DataView(new Uint8Array([1]).buffer), 1], {
    trunk: [
      null,
      { more: [], counts: [0, 0], degree: 0, groups: [], inline: 0 },
    ],
  });
  result.core = "inserted";
} catch (e) {
  result.core = String(e);
}
writeFileSync(`${folder}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
