import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const folder = process.argv[2];
assert(
  folder,
  "usage: bun scripts/verify-trie-logic.ts <construction snapshots> [fixtures]",
);
const fixtures = resolve(process.argv[3] ?? ".local/trie-lex-zero");
const names = ["baseline", "endpoints", "partition", "endpoints-partition"];
const modules = await Promise.all(
  names.map(async (name) => {
    const root = resolve(`${folder}/${name}/clients/structures`);
    return {
      name,
      C: await import(`${root}/core.ts`),
      T: (await import(`${root}/trie.ts`)).Trie,
    };
  }),
);
const { OFFSET_READER: readSrc } = await import("./trie-logic-variants");
const readerFile = resolve(folder, "verify-reader.ts");
writeFileSync(
  readerFile,
  `import assert from 'node:assert/strict';type LogicalStore={nodes:Map<object,any>};${readSrc}\nexport{logicalGet};`,
);
const { logicalGet } = await import(readerFile);
const cases: any[][] = [
  [],
  [["", 0]],
  [
    ["", 0],
    ["00", 1],
    ["0000", 2],
    ["000000", 3],
    ["00ff", 4],
    ["01", 5],
    ["abcd", 6],
    ["abcd00", 7],
    ["ff", 8],
  ],
];
for (const n of [254, 255, 256, 1280, 1281, 5000])
  cases.push(
    Array.from({ length: n }, (_, i) => [i.toString(16).padStart(4, "0"), i]),
  );
for (const layout of ["random", "lexidecimal"])
  cases.push(
    JSON.parse(readFileSync(`${fixtures}/${layout}-10000.json`, "utf8"))
      .entries,
  );
let graphs = 0,
  queries = 0;
for (const [ci, rows] of cases.entries()) {
  let digest: string | undefined;
  for (const { name, C, T } of modules) {
    const storage = new C.MemoryStorage(),
      b = new C.Basin(storage, { seed: new Uint8Array(32).fill(42) });
    const consumer = {
      migration: 7,
      empty: 0n,
      entry: (k: Uint8Array) => (k.length % 2 ? Promise.resolve(1n) : 1n),
      combine: (s: bigint[]) =>
        s.length % 2
          ? Promise.resolve(s.reduce((a, b) => a + b, 0n))
          : s.reduce((a, b) => a + b, 0n),
    };
    const t = await T.build(b, rows, consumer),
      d = C.hex(t.root[6].sha384);
    if (digest) assert.equal(d, digest, `${ci}/${name}`);
    else digest = d;
    graphs++;
  }
  const { C, T } = modules[0];
  class Store extends C.Basin {
    constructor(storage: unknown, options: unknown) {
      super(storage, options);
    }
    nodes = new Map<object, any>();
    counter = 0;
    async seal(node: any, edges: any[]) {
      node[3] = C.query(edges);
      const e: any = [
        Symbol.match,
        node[1],
        node[2],
        node[3],
        0,
        node[5],
        {
          0: node[6][0],
          1: node[6][1],
          version: 0,
          revision: `00000000-0000-4000-8000-${(++this.counter).toString(16).padStart(12, "0")}`,
          length: 0,
          weight: 0n,
          sha384: new Uint8Array(48),
          entropy: new Uint8Array(32),
          rotation: 0,
        },
      ];
      new DataView(e[6].entropy.buffer).setUint32(0, this.counter);
      this.nodes.set(e, node);
      return e;
    }
  }
  const b = new Store(new C.MemoryStorage(), {
    seed: new Uint8Array(32).fill(42),
  });
  const built = (
    await T.buildNode(b, rows, {
      migration: 7,
      empty: 0n,
      entry: () => 1n,
      combine: (s: bigint[]) => s.reduce((a, b) => a + b, 0n),
    })
  ).node;
  const expected = new Map(rows.map(([h, v]) => [h, v]));
  const query = new Set(["", "00", "00000000", "ffff", "abcdef", "abcd00ff"]);
  for (const [h] of rows.slice(0, 256)) {
    query.add(h);
    query.add(h + "ff");
    if (h.length) query.add(h.slice(0, -2));
  }
  for (const h of query) {
    assert.equal(logicalGet(b, built, C.key(h)), expected.get(h), `${ci}/${h}`);
    queries++;
  }
}
console.log(
  JSON.stringify({
    canonical_graphs: graphs,
    reader_queries: queries,
    fixtures: cases.length,
  }),
);
