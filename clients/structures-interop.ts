import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { build, verify, Archive } from "./structure-fixture";
import { stringify, parse } from "./json0";
import { utf8, nodeKey, link } from "./structures/core";
const seed = new Uint8Array(32).fill(42),
  rust = "target/debug/examples/fixture",
  go = ".local/structures-go";
assert(
  existsSync(rust),
  "build Rust fixture first: cargo build -p basinsync-structures --example fixture",
);
assert(
  existsSync(go),
  "build Go fixture first: cd go/structures && go build -o ../../.local/structures-go ./cmd/fixture",
);
const run = (binary: string, mode: string, input: unknown) => {
  const result = Bun.spawnSync([binary, mode], {
    stdin: utf8(stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  return parse<any>(new TextDecoder().decode(result.stdout));
};
const cases: any[] = [
  { kind: "trie", seed, entries: [] },
  {
    kind: "trie",
    seed,
    entries: [
      ["", null],
      ["00", Symbol.match],
      ["ab", -123456789012345678901234567890n],
      [
        "abcd",
        {
          ["__proto__"]: new Uint8Array([1, 2]),
          "\uffff": 0,
          "\u{10000}": Symbol.for("shared"),
        },
      ],
    ],
  },
  ...[63, 64, 1280, 1281, 5000].map((n) => ({
    kind: "trie",
    seed,
    entries: Array.from({ length: n }, (_, i) => [
      i.toString(16).padStart(4, "0"),
      i % 7 === 0 ? null : BigInt(i),
    ]),
  })),
  { kind: "volume", seed, files: [] },
  {
    kind: "volume",
    seed,
    files: [
      ["/empty", new Uint8Array()],
      ["/a/b", Uint8Array.from({ length: 20000 }, (_, i) => i & 255)],
      ["/\uffff", utf8("bmp")],
      ["/\u{10000}", utf8("astral")],
    ],
  },
];
cases.push({
  kind: "volume",
  seed,
  files: [["/kept/file", utf8("x")]],
  directories: ["/empty", "/deep/empty"],
});
cases.push({
  kind: "pages",
  seed,
  pages: [
    [0n, new Uint8Array()],
    [7n, Uint8Array.from({ length: 16384 }, (_, i) => i & 255)],
    [2n ** 200n + 57n, utf8("large page ID")],
  ],
  queries: [0n, 1n, 7n, 2n ** 200n + 57n],
});
mkdirSync(".local/trie-interop", { recursive: true });
const writers = ["typescript", "rust", "go"],
  readers = [...writers];
let count = 0;
for (let i = 0; i < cases.length; i++) {
  const input = cases[i];
  let expected: any;
  for (const writer of writers) {
    const archive: Archive =
      writer === "typescript"
        ? await build(input)
        : run(writer === "rust" ? rust : go, "build", input);
    writeFileSync(
      `.local/trie-interop/${i}-${writer}.json`,
      stringify(archive),
    );
    for (const reader of readers) {
      const rawOutput =
        reader === "typescript"
          ? await verify(archive)
          : run(reader === "rust" ? rust : go, "verify", archive);
      const output = parse<any>(stringify(rawOutput));
      assert.deepEqual(
        output.keys,
        (
          await Promise.all(
            archive.objects.map(([e]) => nodeKey(link(e), "old")),
          )
        ).sort(),
        `object addresses: ${writer} -> ${reader}`,
      );
      delete output.keys;
      if (!expected) expected = output;
      assert.deepEqual(output, expected, `case ${i}: ${writer} -> ${reader}`);
      count++;
    }
  }
  console.log(
    `put of success: ${input.kind} case ${i}, ${writers.length} writers x ${readers.length} readers`,
  );
}
console.log(
  `Interoperability passed: ${count} writer/reader cases; artifacts .local/trie-interop`,
);
