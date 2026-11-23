import assert from "node:assert/strict";
import { all, before, concat, wrap, nestedMessage, NESTED, MARGIN } from "./envbuf";
import { encode, toReference, VT_VECTOR_UINT } from "./flexbuffer";
import { encode as lex, decode as unlex } from "./lexidecimal";
import {coordinateLength,trimRetryMargins,eventEnvelope} from "./events";
import { objectKeys } from "./object-keys";
export {coordinateLength,trimRetryMargins} from "./events";

export const bulkmanifestPath="sts/0/databasin/bulkmanifest";
export type BulkIndex={lowest:bigint;ends:number[];coordinate:bigint};
export function boundary(index:BulkIndex,n:number):number{return n===0?0:index.ends[n-1];}
export function key(lowest:bigint,highest:bigint,start:number,coordinate:bigint):string {
  assert(lowest>0n&&highest>lowest&&coordinate>=0n);assert(Number.isSafeInteger(start)&&start>=16&&start%8===0);const key=`${objectKeys.analogue}${lex(~lowest)}/${lex(~highest)}/v0/${start}/${coordinate}`;assert(key.length<=1024);return key;
}
export function fromKey(keyText:string):{lowest:bigint;highest:bigint;start:number;coordinate:bigint} {
  const prefix=objectKeys.analogue;assert(keyText.startsWith(prefix));const parts=keyText.slice(prefix.length).split("/");assert(parts.length===5&&parts[2]==="v0");
  const coordinate=BigInt(parts[4]),start=Number(parts[3]),lowest=~unlex(parts[0]),highest=~unlex(parts[1]);assert.equal(key(lowest,highest,start,coordinate),keyText);return {lowest,highest,start,coordinate};
}
export function encodeBulkOrder(lowest:bigint,events:Uint8Array[]):Uint8Array {
  assert(lowest>0n&&events.length>0);const ends:number[]=[];
  const coordinate=eventCoordinate(events[0])??0n;let end=0;const trimmed:Uint8Array[]=[];
  for(const event of events){eventEnvelope(event);const at=eventCoordinate(event);if(at!==undefined)assert.equal(at,coordinate+BigInt(end));assert(end%(2**(event[3]&31))===0,"event alignment incompatible with BulkOrder boundary");const bytes=trimRetryMargins(event);trimmed.push(bytes);end+=bytes.length;ends.push(end);}
  const footer=wrap(encode([Symbol.species,"sync.memoremix.com",bulkmanifestPath,{lowest,ends,coordinate}]));
  return concat([...trimmed,footer,wrap(new Uint8Array(8),MARGIN)]);
}
export function decodeBulkOrder(bytes:Uint8Array):{index:BulkIndex;events:Uint8Array[];range:{start:number;end:number}} {
  const frames=all(bytes),readable=frames.filter(e=>e.format!==MARGIN),footer=readable.pop()!;
  assert.equal(footer.format,5);const tuple=toReference(new Uint8Array(footer.content).buffer);
  assert.equal(tuple.length(),4);assert.equal(tuple.get(0).symbolValue(),Symbol.species);assert.equal(tuple.get(1).stringValue(),"sync.memoremix.com");assert.equal(tuple.get(2).stringValue(),bulkmanifestPath);
  assert.notEqual((tuple.get(3).get("ends") as any).valueType,VT_VECTOR_UINT);
  const index=tuple.get(3).toObject() as BulkIndex;
  assert.deepEqual(Object.keys(index).sort(),["coordinate","ends","lowest"]);
  assert(typeof index.coordinate==="bigint"&&index.coordinate>=0n&&typeof index.lowest==="bigint"&&index.lowest>0n&&index.ends.length>0);
  let previous=0;
  index.ends.forEach(end=>{assert(Number.isSafeInteger(end)&&end%8===0&&end>previous);previous=end;});
  assert.equal(index.ends.at(-1),footer.start);assert.equal(readable.length,index.ends.length);
  const events=readable.map((frame,i)=>{assert.equal(frame.format,NESTED);assert.equal(frame.start,boundary(index,i));assert.equal(frame.end,index.ends[i]);return bytes.subarray(frame.start,frame.end);});
  events.forEach((event,i)=>{const at=eventCoordinate(event);if(at!==undefined)assert.equal(at,index.coordinate+BigInt(boundary(index,i)));assert.equal(coordinateLength(event),event.length,"archived event must have no retry margin");});
  assert(frames.slice(readable.length+1).every(frame=>frame.format===MARGIN));
  assert.equal(before(bytes,footer.end).format,5);
  return {index,events,range:{start:footer.start,end:footer.end}};
}
export function eventCoordinate(bytes:Uint8Array):bigint|undefined {
  const frames=all(eventEnvelope(bytes).content),footer=frames.filter(e=>e.format!==MARGIN).at(-1)!;
  const tuple=toReference(new Uint8Array(footer.content).buffer);
  const coordinate=(tuple.get(3).toObject() as {coordinate?:bigint}).coordinate;
  if(coordinate!==undefined)assert(typeof coordinate==="bigint"&&coordinate>=0n);
  return coordinate;
}
