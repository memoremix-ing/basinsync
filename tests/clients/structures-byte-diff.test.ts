import { test, expect } from "bun:test";
import { Basin, MemoryStorage, concat } from "./structures/core";
import { TrieBytes } from "./structures/trie-bytes";
import { chunkBytes } from "./structures/chunking";
import { diffBytes, type ByteSequence, type ByteEdit } from "./structures/byte-diff";
const data = (n: number) => { let x=12345; return Uint8Array.from({length:n},()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>24}); };
const basin = () => new Basin(new MemoryStorage(), {seed:new Uint8Array(32).fill(42)});
async function patch(bytes:Uint8Array,next:ByteSequence,edits:ByteEdit[]) {
 const chunks:Uint8Array[]=[];let at=0,newAt=0;
 for(const e of edits){expect(e.before.start>=BigInt(at)).toBe(true);expect(e.after.start-BigInt(newAt)).toBe(e.before.start-BigInt(at));chunks.push(bytes.slice(at,Number(e.before.start)),await next.read(e.after.start,Number(e.after.length)));at=Number(e.before.start+e.before.length);newAt=Number(e.after.start+e.after.length)}
 return concat([...chunks,bytes.slice(at)]);
}
test("content-defined byte trie edits retain canonical roots, old snapshots and reconstructable diffs",async()=>{
 const b=basin();let bytes:Uint8Array=data(10000),file=await TrieBytes.content(b,bytes);
 let x=882;
 for(let i=0;i<40;i++){x^=x<<13;x^=x>>>17;x^=x<<5;const at=(x>>>0)%(bytes.length+1),remove=Math.min(i%23,bytes.length-at),add=data(i%31);
 const expected=concat([bytes.slice(0,at),add,bytes.slice(at+remove)]),next=await file.splice(BigInt(at),BigInt(remove),add);
 expect(next.root).toEqual((await TrieBytes.content(b,expected)).root);expect(await patch(bytes,next.sequence(),await file.diff(next))).toEqual(expected);expect(await file.read(0n,bytes.length)).toEqual(bytes);bytes=expected;file=next;}
});
test("content boundaries ignore caller fragments and both fixed/CDC tries reconstruct shifts",async()=>{
 const bytes=data(300000),b=basin();expect([...chunkBytes([bytes])]).toEqual([...chunkBytes([bytes.slice(0,17),bytes.slice(17,10001),bytes.slice(10001)])]);
 for(const original of [await TrieBytes.build(b,bytes,true),await TrieBytes.content(b,bytes)]){
 for(const [at,remove,add] of [[100000,0,data(97)],[270000,103,new Uint8Array()],[0,bytes.length,new Uint8Array()]] as const){const target=concat([bytes.slice(0,at),add,bytes.slice(at+remove)]),next=await original.splice(BigInt(at),BigInt(remove),add);expect(await patch(bytes,next.sequence(),await original.diff(next))).toEqual(target);}}
});
test("local refinement isolates sparse writes",async()=>{const b=basin(),bytes=data(12000),target=bytes.slice();target[100]^=255;target[9000]^=255;const a=await TrieBytes.content(b,bytes),c=await TrieBytes.content(b,target),edits=await a.diff(c);expect(edits.reduce((n,e)=>n+e.after.length,0n)).toBe(2n);expect(await patch(bytes,c.sequence(),edits)).toEqual(target);});
test("bounded local scripts match an independent edit-distance model and fall back safely", async () => {
  const { localByteDiff } = await import("./structures/local-byte-diff");
  let x = 67582;
  for (let n = 0; n < 160; n++) {
    const random = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
    const a = Uint8Array.from({ length: random() % 22 }, () => random() % 5), b = Uint8Array.from({ length: random() % 22 }, () => random() % 5);
    const dp = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : Math.min(dp[i - 1][j], dp[i][j - 1]) + 1;
    const edits = localByteDiff(a, b)!;
    expect(edits.reduce((n, e) => n + Number(e.before.length + e.after.length), 0)).toBe(dp[a.length][b.length]);
    const sequence: ByteSequence = { root: { size: BigInt(b.length), rank: 0, expand: async () => [] }, read: async (at, n) => b.slice(Number(at), Number(at) + n) };
    expect(await patch(a, sequence, edits)).toEqual(b);
  }
  expect(localByteDiff(new Uint8Array(500).fill(1), new Uint8Array(500).fill(2), 8)).toBeNull();
});
