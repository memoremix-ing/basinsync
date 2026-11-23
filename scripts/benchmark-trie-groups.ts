import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const source = process.argv[2];
assert(
  source,
  "usage: bun scripts/benchmark-trie-groups.ts <logical-final source snapshot> [fixtures] [output]",
);
const base = resolve(source),
  fixtures = resolve(process.argv[3] ?? ".local/trie-lex-zero");
const root = resolve(process.argv[4] ?? `.local/trie-groups-${Date.now()}`);
mkdirSync(root, { recursive: true });
const workerOriginal = readFileSync("clients/trie-cost-worker.ts", "utf8");
const results: any[] = [];
const variants = (
  Bun.env.TRIE_GROUP_VARIANTS ??
  "baseline,group256,early-equal,hoist-length,group256-early,all,reverse-bounds,group256-reverse"
).split(",");
const rounds = Number(Bun.env.TRIE_GROUP_ROUNDS ?? 5);
assert(Number.isSafeInteger(rounds) && rounds > 0);

for (const v of variants) {
  const folder = `${root}/${v}`;
  cpSync(base, folder, { recursive: true });
  const group256 = [
      "group256",
      "group256-early",
      "group256-reverse",
      "all",
    ].includes(v),
    early = ["early-equal", "group256-early", "all"].includes(v),
    hoist = ["hoist-length", "all"].includes(v);
  const triePath = `${folder}/clients/structures/trie.ts`;
  let trie = readFileSync(triePath, "utf8");
  if (group256) {
    assert(
      trie.includes("rows.length > 63") && trie.includes("bucket.length <= 63"),
      "inspect changed group thresholds",
    );
    trie = trie
      .replace("rows.length > 63", "rows.length > 256")
      .replace("bucket.length <= 63", "bucket.length <= 256");
  }
  if (v.includes("reverse")) {
    const before =
      "reversals: bounds(\n          input.map((r) => r.key.slice().reverse()),\n          compare,\n        ),";
    assert(trie.includes(before));
    trie = trie.replace(before, "reversals: reverseBounds(input),");
    trie += `\nfunction reverseBounds<V,M>(rows:Row<V,M>[]):Bounds<Uint8Array>{
   if(!rows.length)return null;
   let lo=rows[0].key,hi=lo;
   function cmp(a:Uint8Array,b:Uint8Array){const n=Math.min(a.length,b.length);for(let i=0;i<n;i++){const d=a[a.length-1-i]-b[b.length-1-i];if(d)return d;}return a.length-b.length;}
   for(const r of rows){if(cmp(r.key,lo)<0)lo=r.key;if(cmp(r.key,hi)>0)hi=r.key;}
   const low=lo.slice().reverse();return[low,lo===hi?low:hi.slice().reverse()];
  }\n`;
  }
  writeFileSync(triePath, trie);
  const corePath = `${folder}/clients/structures/core.ts`;
  let core = readFileSync(corePath, "utf8");
  if (hoist)
    core = core.replace(
      "for (let i = 0; i < Math.min(a.length, b.length); i++)",
      "const count = Math.min(a.length, b.length);\n  for (let i = 0; i < count; i++)",
    );
  writeFileSync(corePath, core);
  let worker = workerOriginal;
  if (early) {
    assert(worker.includes("if (C.compare(g.keys[m], k) < 0) a = m + 1;"));
    worker = worker.replace(
      "if (C.compare(g.keys[m], k) < 0) a = m + 1;",
      "const cmp = C.compare(g.keys[m], k);\n        if (cmp === 0) return g.values[m];\n        if (cmp < 0) a = m + 1;",
    );
  }
  // Collect tree structure without touching the timed reader.
  worker = worker.replace(
    "samples.logical_ops = ops;",
    `samples.logical_ops = ops;
 const hist:Record<string,number>={}, stats={nodes:0,groups:0,entries:0,maxDepth:0};
 function group(g:any){if(!g.keys.length)return;stats.groups++;stats.entries+=g.keys.length;hist[g.keys.length]=(hist[g.keys.length]??0)+1;}
 function visit(n:any,depth:number){stats.nodes++;stats.maxDepth=Math.max(stats.maxDepth,depth);group(n[6][2]);for(const m of n[6][3]??[]){if(!m)continue;if(Array.isArray(m)){for(const child of m)if(child)visit(Array.isArray(child)?basin.nodes.get(child):child,depth+1);}else group(m);}}
 visit(trie,0);samples.shape={...stats,group_sizes:hist};`,
  );
  writeFileSync(`${folder}/worker.ts`, worker);
}
for (const layout of (Bun.env.TRIE_GROUP_LAYOUTS ?? "random,lexidecimal").split(
  ",",
))
  for (let round = 0; round < rounds; round++) {
    const order = [
      ...variants.slice(round % variants.length),
      ...variants.slice(0, round % variants.length),
    ];
    for (const v of order) {
      const folder = `${root}/${v}`,
        child = Bun.spawn(["bun", `${folder}/worker.ts`], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...Bun.env, TRIE_COST_SOURCE: folder, TRIE_COST_LOGICAL: "1" },
        });
      await child.stdin.write(
        readFileSync(`${fixtures}/${layout}-100000.json`),
      );
      await child.stdin.end();
      const [out, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, error);
      const result = { variant: v, layout, round, ...JSON.parse(out) };
      results.push(result);
      writeFileSync(`${root}/samples.json`, JSON.stringify(results, null, 2));
      console.log(
        v,
        layout,
        round,
        "build",
        result.build_ms.toFixed(1),
        "get",
        ((result.logical_direct_ms * 1000) / result.logical_ops).toFixed(3),
      );
    }
  }
const sha = (s: string) => createHash("sha384").update(s).digest("hex");
writeFileSync(
  `${root}/report.json`,
  JSON.stringify(
    {
      recorded_at: new Date().toISOString(),
      bun: Bun.version,
      entries: 100000,
      rounds,
      group_limit_changes_format: true,
      source_sha384: Object.fromEntries(
        variants.map((v) => [
          v,
          Object.fromEntries(
            [
              "worker.ts",
              "clients/structures/core.ts",
              "clients/structures/trie.ts",
            ].map((p) => [p, sha(readFileSync(`${root}/${v}/${p}`, "utf8"))]),
          ),
        ]),
      ),
      samples: results,
    },
    null,
    2,
  ),
);
