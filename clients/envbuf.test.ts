import { expect,test } from "bun:test";
import { all,at,before,concat,wrap } from "./envbuf";
import { encodeWalEvent,rangesAt,eventTuples,deltasAt,type WalDelta } from "./events";
import { sha384 } from "./client";

test("EnvBuf supports aligned forward/reverse walks, nested magic, and padding validation",()=>{
  const contents=[new Uint8Array(),new Uint8Array([1]),new TextEncoder().encode("enV vNE"),new Uint8Array(256).fill(0xee)];
  const bytes=concat(contents.map(c=>wrap(c))),frames=all(bytes);expect(frames.map(f=>f.content)).toEqual(contents);
  let end=bytes.length;for(const original of [...contents].reverse()){const frame=before(bytes,end);expect(frame.content).toEqual(original);expect(at(bytes,frame.start)).toEqual(frame);end=frame.start;}expect(end).toBe(0);
  const bad=wrap(new Uint8Array([1]));bad[9]=0;expect(()=>all(bad)).toThrow();
  for(let n=1;n<bytes.length;n++)if(!frames.some(f=>f.end===n))expect(()=>all(bytes.subarray(0,n))).toThrow();
});
test("independent EnvBuf event writer records absolute blob offsets across FlexBuffers width boundaries",()=>{
  const commands=[0,1,7,8,255,256,65535,65536].map((length,i)=>{const blob=new Uint8Array(length).fill(i);return {[`flow-${i}`]:{viewpoint:"0",sha384:sha384(blob),blob}};});
  const bytes=encodeWalEvent(commands,{} as any),ranges=rangesAt(bytes);
  expect(eventTuples(bytes).length).toBe(commands.length+1);
  for(const range of ranges){expect(bytes.subarray(range.offset,range.offset+range.length)).toEqual(range.marker.blob);expect(sha384(range.marker.blob)).toBe(range.marker.sha384);}
  const frames=all(bytes);expect(frames.length).toBe(commands.length+2);expect(before(bytes,bytes.length)).toEqual(frames.at(-1)!);
});

test("ingestion-only events have one indexed command and no marker ranges",()=>{
  const delta:WalDelta={version:"test",logical:{base:null,header:new Uint8Array(),frames:[]},physical:{format:"sqlite-wal/1",base:"0",milestone:"1",parent:null,base_sha384:null,segments:[]}};
  const bytes=encodeWalEvent([],delta);
  expect(all(bytes).length).toBe(2);
  expect(eventTuples(bytes).map(t=>t[2])).toEqual(["sts/0/databasin/ingestturso"]);
  expect(rangesAt(bytes)).toEqual([]);
  expect(deltasAt(bytes).turso["default.turso"]).toEqual(delta);
});
