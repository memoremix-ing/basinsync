/** Source-snapshot experiments only; capability-disabled trees are not publication formats. */
import assert from "node:assert/strict";
export const OFFSET_READER =
  "function logicalGet(store: LogicalStore, root: any, raw: Uint8Array): number | undefined {\n let node=root,offset=0;\n for(let depth=0;;depth++){\n  assert(depth<256);\n  const prefix=node[5].prefix as Uint8Array|null;\n  if(prefix){\n   if(raw.length-offset<prefix.length)return undefined;\n   for(let i=0;i<prefix.length;i++)if(prefix[i]!==raw[offset+i])return undefined;\n   offset+=prefix.length;\n  }\n  const own=offsetFind(node[6][2],raw,offset);\n  if(own!==undefined)return own;\n  if(offset===raw.length)return undefined;\n  const byte=raw[offset],member=node[6][3]?.[byte>>4];\n  if(!member)return undefined;\n  if(!Array.isArray(member))return offsetFind(member,raw,offset);\n  const child=member[byte&15];if(!child)return undefined;\n  offset++;node=Array.isArray(child)?store.nodes.get(child):child;assert(node);\n }\n}\nfunction offsetCompare(a:Uint8Array,b:Uint8Array,offset:number){\n const n=Math.min(a.length,b.length-offset);\n for(let i=0;i<n;i++){const d=a[i]-b[offset+i];if(d)return d;}\n return a.length-(b.length-offset);\n}\nfunction offsetFind(g:{keys:Uint8Array[];values:number[]},key:Uint8Array,offset:number):number|undefined{\n let a=0,b=g.keys.length;\n while(a<b){const m=(a+b)>>1;if(offsetCompare(g.keys[m],key,offset)<0)a=m+1;else b=m;}\n return a<g.keys.length&&offsetCompare(g.keys[a],key,offset)===0?g.values[a]:undefined;\n}\n";
export function variantSources(trie: string, worker: string, v: string) {
  let s = trie,
    w = worker;
  if (v.includes("endpoints") || v.startsWith("optimized")) {
    const a = s.indexOf("      let prefixLength ="),
      b = s.indexOf("      const prefix =", a);
    assert(a > 0 && b > a);
    s =
      s.slice(0, a) +
      `      let prefixLength=0;
      if(input.length){const first=input[0].key,last=input[input.length-1].key,limit=Math.min(first.length,last.length);while(prefixLength<limit&&first[prefixLength]===last[prefixLength])prefixLength++;}
` +
      s.slice(b);
    s = s.replace(
      "keys: bounds(\n          input.map((r) => r.key),\n          compare,\n        ),",
      "keys: input.length ? [input[0].key,input[input.length-1].key] : null,",
    );
  }
  if (v.includes("partition") || v.startsWith("optimized")) {
    const oldLow = `        const low: (Local<V, M> | null)[] = Array(16).fill(null);
        for (let n = 0; n < 16; n++) {
          const part = bucket.filter((r) => (r.key[0] & 15) === n);`;
    const newLow = `        const low: (Local<V, M> | null)[] = Array(16).fill(null);
        const parts: Row<V,M>[][]=Array.from({length:16},()=>[]);
        for(const r of bucket)parts[r.key[0]&15].push(r);
        for (let n = 0; n < 16; n++) {
          const part = parts[n];`;
    assert(s.includes(oldLow));
    s = s.replace(oldLow, newLow);
    const oldHigh = `        for (let high = 0; high < 16; high++) {
          const bucket = rows.filter(
            (r) => r.key.length > 0 && r.key[0] >> 4 === high,
          );`;
    const newHigh = `        const parts: Row<V,M>[][]=Array.from({length:16},()=>[]);
        for(const r of rows)if(r.key.length)parts[r.key[0]>>4].push(r);
        for (let high = 0; high < 16; high++) {
          const bucket = parts[high];`;
    assert(s.includes(oldHigh));
    s = s.replace(oldHigh, newHigh);
  }
  if (v.includes("no-cuts"))
    s = s.replace(
      "inlineCount() > 1280",
      "inlineCount() > Number.MAX_SAFE_INTEGER",
    );
  if (v.includes("headers-off") || v.includes("metadata-off")) {
    const n = "nullity: BigInt(input.filter((r) => r.value === null).length),";
    assert(s.includes(n));
    s = s.replace(n, "nullity: 0n,");
    s = s
      .replace(
        "keys: bounds(\n          input.map((r) => r.key),\n          compare,\n        ),",
        "keys: null,",
      )
      .replace(
        "keys: input.length ? [input[0].key,input[input.length-1].key] : null,",
        "keys: null,",
      );
    const l =
      "lengths: bounds(\n          input.map((r) => r.key.length),\n          (a, b) => a - b,\n        ),";
    assert(s.includes(l));
    s = s.replace(l, "lengths: null,");
  }
  if (v.includes("consumer-off") || v.includes("metadata-off")) {
    s = s.replace(
      "const summary = c.entry(k, value);",
      "const summary = null;",
    );
    const q =
      "const combined = input.length\n        ? c.combine(input.map((r) => r.summary))\n        : c.empty;";
    assert(s.includes(q));
    s = s.replace(q, "const combined = c.empty;");
  }
  if (v.includes("consumer-off") || v.includes("metadata-off")) {
    const a = w.indexOf("const c = {"),
      b = w.indexOf("const cryptoStats", a);
    w =
      w.slice(0, a) +
      "const c={migration:7,empty:null,entry:()=>null,combine:()=>null};\n" +
      w.slice(b);
  }

  const a = w.indexOf("function logicalGet("),
    b = w.indexOf("const logical =", a),
    get = w.slice(a, b);
  assert(a >= 0 && b > a);
  if (v === "hoisted-find") {
    const fa = get.indexOf("    const find ="),
      fb = get.indexOf("    const own =", fa);
    assert(fa > 0 && fb > fa);
    const inner = get
      .slice(fa, fb)
      .replace(
        "    const find = (g: { keys: Uint8Array[]; values: number[] }) => {",
        "function find(g: {keys:Uint8Array[];values:number[]}, k:Uint8Array) {",
      )
      .replace(/    };\s*$/, "}\n");
    let updated = get.slice(0, fa) + get.slice(fb);
    updated = updated
      .replace("find(node[6][2])", "find(node[6][2],k)")
      .replace("find(member)", "find(member,k)");
    w = w.slice(0, a) + inner + updated + w.slice(b);
  }
  if (v === "manual-prefix") {
    const old = `      if (k.length < prefix.length || !prefix.every((b, i) => b === k[i]))
        return undefined;`;
    assert(w.includes(old));
    w = w.replace(
      old,
      `      if(k.length<prefix.length)return undefined;
      for(let i=0;i<prefix.length;i++)if(prefix[i]!==k[i])return undefined;`,
    );
  }
  if (v === "offset-only") {
    let g = get.replace("    k = raw;", "    offset = 0;");
    g = g
      .replace(
        "k.length < prefix.length || !prefix.every((b, i) => b === k[i])",
        "raw.length-offset < prefix.length || !prefix.every((b, i) => b === raw[offset+i])",
      )
      .replace("k = k.subarray(prefix.length);", "offset += prefix.length;")
      .replace(
        "C.compare(g.keys[m], k)",
        "offsetCompare(g.keys[m], raw, offset)",
      )
      .replace(
        "C.equal(g.keys[a], k)",
        "offsetCompare(g.keys[a],raw,offset)===0",
      )
      .replace("if (!k.length)", "if (offset===raw.length)")
      .replace("k[0] >> 4", "raw[offset] >> 4")
      .replace("k[0] & 15", "raw[offset] & 15")
      .replace("k = k.subarray(1);", "offset++;");
    g += `function offsetCompare(a:Uint8Array,b:Uint8Array,offset:number){for(let i=0;i<Math.min(a.length,b.length-offset);i++){const d=a[i]-b[offset+i];if(d)return d;}return a.length-(b.length-offset);}\n`;
    w = w.slice(0, a) + g + w.slice(b);
  }
  if (v === "offset-combined") w = w.slice(0, a) + OFFSET_READER + w.slice(b);

  if (v === "offset-reader" || v === "no-cuts-offset")
    w = w.slice(0, a) + OFFSET_READER + w.slice(b);
  return { trie: s, worker: w };
}
