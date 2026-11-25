import { test, expect } from "bun:test";
import vectors from "../vectors/chunking.json";
import { Basin, MemoryStorage, concat, capability, link, type Edge } from "./structures/core";
import { Volume, buildMixedBlock } from "./structures/volume";
import { chunkBytes } from "./structures/chunking";
import * as crc from "./structures/crc64nvme";
const bytes = (n: number, x = 0x13579bdf) => Uint8Array.from({length:n},()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>24});
const setup = (store = new MemoryStorage()) => new Basin(store,{seed:new Uint8Array(32).fill(42)});
const pages = (b:Uint8Array,size:number):[bigint,Uint8Array][] => Array.from({length:Math.ceil(b.length/size)},(_,i)=>[BigInt(i),b.slice(i*size,(i+1)*size)]);
test("two-trie blocks concatenate either/both empty halves and read across boundaries", async()=>{
 const b=setup();
 for(const [prefixLength,suffixLength,size] of [[0,0,4096],[0,9000,4096],[230000,0,4096],[190003,17001,4096],[111111,40000,16384]]){
  const prefix=bytes(prefixLength),suffix=bytes(suffixLength,82),expected=concat([prefix,suffix]);
  const block=await buildMixedBlock(b,prefix,pages(suffix,size),{},size),volume=await Volume.fromBlocks(b,[["/file",block]]);
  expect(block.digest).toEqual(crc.hash(expected));expect(await volume.read("/file")).toEqual(expected);
  for(const at of [0,Math.max(0,prefixLength-19),prefixLength,prefixLength+3,expected.length+1]) {b.clearCache();expect(await volume.read("/file",{start:at,length:77})).toEqual(expected.slice(at,at+77));}
  expect(await volume.page("/file",0n)).toEqual(suffixLength?suffix.slice(0,size):undefined);
 }
});
test("whole-file CRC and directory identity are independent of the partition",async()=>{
 const b=setup(),data=bytes(200000),ids:Uint8Array[]=[];
 for(const split of [0,65537,data.length]){
  const block=await buildMixedBlock(b,data.slice(0,split),pages(data.slice(split),4096)),v=await Volume.fromBlocks(b,[["/same",block]]);
  expect(block.digest).toEqual(crc.hash(data));ids.push((await b.load(v.root)).get("6").get(2).get(1).blobValue()!);
 }
 expect(ids[0]).toEqual(ids[1]);expect(ids[1]).toEqual(ids[2]);
});
test("ranges do not fetch the other half's trie body",async()=>{
 class Guard extends MemoryStorage { denied=new Set<string>();override async get(e:Edge){if(this.denied.has(capability(link(e))))throw Error("unavailable half");return super.get(e);} }
 const store=new Guard(),b=setup(store),prefix=bytes(1000000),suffix=bytes(8*1024*1024,55);
 const block=await buildMixedBlock(b,prefix,pages(suffix,4096)),v=await Volume.fromBlocks(b,[["/file",block]]);
 const parts=(await b.load(block.edge)).get("6").get(2);
 const { edgeFrom, object }=await import("./structures/core");
 const collect=(source:any):Edge[]=>{
  if(Array.isArray(source))return [source as Edge];
  const out:Edge[]=[];for(const m of source[6][3]??[])if(Array.isArray(m))for(const child of m)if(child)out.push(...collect(child));return out;
 };
 const roots=[0,1].map(i=>parts.get(i).isMap()?collect(object(parts.get(i))):[edgeFrom(parts.get(i))]);
 expect(roots[0].length>0&&roots[1].length>0).toBe(true);
 for(const e of roots[1])store.denied.add(capability(link(e)));b.clearCache();expect(await v.read("/file",{start:19,length:23})).toEqual(prefix.slice(19,42));
 store.denied.clear();for(const e of roots[0])store.denied.add(capability(link(e)));b.clearCache();expect(await v.read("/file",{start:prefix.length+19,length:23})).toEqual(suffix.slice(19,42));
});
test("file diffs span both tries and ignore changes to the partition alone",async()=>{
 const b=setup(),original=bytes(180000);
 const make=async(data:Uint8Array,split:number)=>Volume.fromBlocks(b,[["/file",await buildMixedBlock(b,data.slice(0,split),pages(data.slice(split),4096))]]);
 const a=await make(original,70001),same=await make(original,0);expect(await a.diff("/file",same)).toEqual([]);
 const target=concat([original.slice(0,69000),new Uint8Array([4,5,6]),original.slice(69020)]);target[70000]^=255;
 const c=await make(target,69984),edits=await a.diff("/file",c),parts:Uint8Array[]=[];let cursor=0;
 for(const e of edits){parts.push(original.slice(cursor,Number(e.before.start)),await c.read("/file",{start:Number(e.after.start),length:Number(e.after.length)}));cursor=Number(e.before.start+e.before.length);}
 parts.push(original.slice(cursor));expect(concat(parts)).toEqual(target);expect(await a.read("/file")).toEqual(original);
});
test("shared chunk boundaries and invalid page-size inputs",async()=>{
 for(const v of vectors){const data=v.pattern==="random"?bytes(v.length,v.seed):Uint8Array.from({length:v.length},(_,i)=>v.pattern==="runs"?1+Math.floor(i/16384):0);expect([...chunkBytes([data])].map(b=>b.length)).toEqual(v.lengths);}
 const b=setup();await expect(buildMixedBlock(b,new Uint8Array(),[],{},0)).rejects.toThrow();await expect(buildMixedBlock(b,new Uint8Array(),[[0n,bytes(4097)]])).rejects.toThrow();
});
