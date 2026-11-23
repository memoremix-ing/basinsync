import {expect,test} from "bun:test";
import {encodeBulkOrder,decodeBulkOrder,key,fromKey,eventCoordinate,coordinateLength} from "./bulkorder";
import {encodeTuples,entryDigest,trimRetryMargins} from "./events";
import {at,all,concat,wrap,MARGIN,nestedMessage} from "./envbuf";
import {encode} from "./flexbuffer";
import { objectKeys } from "./object-keys";

const event=encodeTuples([[Symbol.species,"sync.memoremix.com","sts/0/databasin/ingestturso",{turso:{}}]]);
test("dense BulkOrder index retains nested event boundaries and arbitrary-precision lowest",()=>{
  for(const lowest of [1n,42n,65535n,1n<<256n])for(const count of [1,2,3,4,255,256]){
    const bytes=encodeBulkOrder(lowest,Array(count).fill(event));const {index,events,range}=decodeBulkOrder(bytes);
    expect(index).toEqual({lowest,coordinate:0n,ends:Array.from({length:count},(_,i)=>(i+1)*coordinateLength(event))});
    expect(range.start).toBe(count*coordinateLength(event));expect(events.length).toBe(count);
    for(const extracted of events){expect(extracted.buffer).toBe(bytes.buffer);expect(entryDigest(extracted)).toBe(entryDigest(event));}
    expect(fromKey(key(lowest,lowest+BigInt(count),range.start,0n))).toEqual({lowest,highest:lowest+BigInt(count),start:range.start,coordinate:0n});
  }
});
test("BulkOrder rejects malformed bounds, framing, and dense indexes",()=>{
  expect(()=>encodeBulkOrder(0n,[event])).toThrow();expect(()=>encodeBulkOrder(1n,[])).toThrow();
  for(const text of [`${objectKeys.analogue}0yvf/0yve`,`${objectKeys.analogue}0yve/0yve`,`${objectKeys.analogue}0zg1/0zg2`,`${objectKeys.analogue}0yve/0yvd/x`])expect(()=>fromKey(text)).toThrow();
  const valid=encodeBulkOrder(1n,[event]),bad=new Uint8Array(valid);bad[coordinateLength(event)-1]^=1;expect(()=>decodeBulkOrder(bad)).toThrow();
  for(const ends of [[],[0],[1],[coordinateLength(event)+8],[-1],[1.5],[coordinateLength(event),coordinateLength(event)]]){
    const bytes=new Uint8Array([...trimRetryMargins(event),...wrap(encode([Symbol.species,"sync.memoremix.com","sts/0/databasin/bulkmanifest",{lowest:1n,coordinate:0n,ends}])),...wrap(new Uint8Array(8),MARGIN)]);
    expect(()=>decodeBulkOrder(bytes)).toThrow();
  }
});

test("v0 key is independent of the BulkManifest representation and length",()=>{
  const original=encodeBulkOrder(1n,[event,event]),a=decodeBulkOrder(original),footer=at(original,a.range.start);
  const alternative=concat([...a.events,wrap(concat([new Uint8Array(8),footer.content])),wrap(new Uint8Array(8),MARGIN)]),b=decodeBulkOrder(alternative);
  expect(b.events).toEqual(a.events);expect(b.range.start).toBe(a.range.start);expect(b.range.end).not.toBe(a.range.end);
  expect(key(1n,3n,a.range.start,0n)).toBe(key(1n,3n,b.range.start,0n));expect(fromKey(key(1n,3n,b.range.start,0n))).toEqual({lowest:1n,highest:3n,start:a.range.start,coordinate:0n});
});

test("byte coordinates retain bigint precision and exclude length-changing margins",()=>{
  const coordinate=1n<<256n,command=[Symbol.species,"sync.memoremix.com","sts/0/databasin/ingestturso",{turso:{}}];
  const first=encodeTuples([command],coordinate),second=encodeTuples([command],coordinate+BigInt(coordinateLength(first)));
  const bytes=encodeBulkOrder(42n,[first,second]),decoded=decodeBulkOrder(bytes);
  expect(decoded.index.coordinate).toBe(coordinate);
  expect(fromKey(key(42n,44n,decoded.range.start,coordinate)).coordinate).toBe(coordinate);
  const extra=concat([first,wrap(new Uint8Array(8),MARGIN)]);
  expect(entryDigest(extra)).toBe(entryDigest(first));expect(encodeBulkOrder(42n,[extra,second])).toEqual(bytes);expect(eventCoordinate(extra)).toBe(coordinate);expect(coordinateLength(extra)).toBe(coordinateLength(first));
  expect(decodeBulkOrder(encodeBulkOrder(42n,[extra,second])).index.ends).toEqual([coordinateLength(first),coordinateLength(first)+coordinateLength(second)]);
  expect(()=>encodeBulkOrder(42n,[second,first])).toThrow();
  for(const bad of ["-1","01","0x10"])expect(()=>fromKey(key(42n,44n,16,0n).replace(/0$/,bad))).toThrow();
});

test("trimming preserves internal margins, messages, alignment, and digest",()=>{
  const original=encodeTuples([{margin:new Uint8Array([1,2,3])},[Symbol.species,"sync.memoremix.com","sts/0/databasin/ingestturso",{turso:{}}]],0n);
  const trimmed=trimRetryMargins(original);
  expect(trimRetryMargins(trimmed)).toBe(trimmed);
  expect(entryDigest(trimmed)).toBe(entryDigest(original));
  expect(coordinateLength(original)).toBe(trimmed.length);
  expect(Array.from(trimmed.subarray(0,4))).toEqual(Array.from(original.subarray(0,4)));
  const frames=all(nestedMessage(trimmed));expect(frames[0].format).toBe(MARGIN);expect(Array.from(frames[0].content)).toEqual([1,2,3]);expect(frames.at(-1)!.format).toBe(5);
});
