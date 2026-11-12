import assert from "node:assert/strict";
import { encode, toReference, type Reference } from "./flexbuffer";
import { all, wrap, concat } from "./envbuf";
import { encode as lex } from "./lexidecimal";

export type Marker={viewpoint:string;sha384:string;blob:Uint8Array};
export type FlowMarker={flow:string;marker:Marker};
export type BlobRange=FlowMarker&{offset:number;length:number};
const namespace="sync.memoremix.com",command="sts/0/databasin/commitflow",ingest="sts/0/databasin/ingestturso";
export const manifestPath="sts/0/databasin/rangemanifest";
export const sweepPath="sts/0/databasin/sweepheap";
export const reservePath="sts/0/databasin/reserveheap";
export type LogicalFrames={base:Uint8Array|null;header:Uint8Array;frames:Uint8Array[]};
export type TursoDelta={version:string;logical:LogicalFrames;physical:{before:string;after:string;size:number;pages:{number:number;data:Uint8Array}[]}};
export type WalDelta={version:string;logical:LogicalFrames;physical:{format:"sqlite-wal/1";base:string;milestone:string;parent:string|null;base_sha384:string|null;segments:Uint8Array[]}};
export type Deltas<D=TursoDelta|WalDelta>={turso:Record<string,D>};

export function encodeEvent(markers:Record<string,Marker>,deltas?:Deltas<TursoDelta>):Uint8Array {
  const owned:Record<string,Marker>=Object.create(null);
  for(const [flow,marker] of Object.entries(markers))owned[flow]={...marker,blob:new Uint8Array(marker.blob)};
  return encode([[Symbol.species,namespace,command,{markers:owned,...(deltas?{deltas}:{})}]]);
}
export function encodeTuples(commands:unknown[][]):Uint8Array {
  const envelopes:Record<string,unknown>=Object.create(null),chunks:Uint8Array[]=[];let end=0;
  for(const tuple of commands){const chunk=wrap(encode(tuple));end+=chunk.length;chunks.push(chunk);envelopes[lex(BigInt(end))]=tuple.slice(0,3);}
  chunks.push(wrap(encode([Symbol.species,namespace,manifestPath,{envelopes}])));return concat(chunks);
}
export function encodeWalEvent(commands:Record<string,Marker>[],delta:WalDelta):Uint8Array {
  return encodeTuples([...commands.map(markers=>[Symbol.species,namespace,command,{markers}]),[Symbol.species,namespace,ingest,{turso:{"default.turso":delta}}]]);
}
export function eventTuples(bytes:Uint8Array):unknown[][] {
  if(bytes[0]===0x65&&bytes[1]===0x6e&&bytes[2]===0x56)return all(bytes).map(e=>toReference(new Uint8Array(e.content).buffer).toObject() as unknown[]).slice(0,-1);
  return toReference(new Uint8Array(bytes).buffer).toObject() as unknown[][];
}
function tuples(bytes:Uint8Array):{tuple:Reference;base:number}[] {
  let commands:{tuple:Reference;base:number}[];
  if(bytes[0]===0x65&&bytes[1]===0x6e&&bytes[2]===0x56){
    const frames=all(bytes);assert(frames.length>=3);
    const refs=frames.map(e=>{assert.equal(e.format,5);return toReference(new Uint8Array(e.content).buffer);});
    const manifest=refs.pop()!;assert.equal(manifest.get(0).symbolValue(),Symbol.species);assert.equal(manifest.get(1).stringValue(),namespace);assert.equal(manifest.get(2).stringValue(),manifestPath);
    const index=manifest.get(3).get("envelopes").toObject() as Record<string,unknown>;
    assert.equal(Object.keys(index).length,refs.length);
    for(let n=0;n<refs.length;n++)assert.deepEqual(index[lex(BigInt(frames[n].end))],[Symbol.species,namespace,refs[n].get(2).stringValue()]);
    commands=refs.map((tuple,n)=>({tuple,base:frames[n].contentStart}));
  }else{
    const root=toReference(new Uint8Array(bytes).buffer);assert(root.isVector()&&root.length()>0);
    commands=Array.from({length:root.length()},(_,n)=>({tuple:root.get(n),base:0}));
  }
  commands.forEach(({tuple},n)=>{assert(tuple.isVector()&&tuple.length()===4);assert.equal(tuple.get(0).symbolValue(),Symbol.species);assert.equal(tuple.get(1).stringValue(),namespace);const path=tuple.get(2).stringValue();if(n+1===commands.length&&commands.length>1)assert.equal(path,ingest);else assert(path===command||path===reservePath||path===sweepPath);});return commands;
}
export function rangesAt(bytes:Uint8Array):BlobRange[] {
  const commands=tuples(bytes);if(commands.length>1)commands.pop();const entries:BlobRange[]=[];
  for(const {tuple,base} of commands){
    if(tuple.get(2).stringValue()!==command)continue;
    const markers=tuple.get(3).get("markers");assert(markers.isMap());
    for(const flow of Object.keys(markers.toObject() as object)){
      const marker=markers.get(flow),viewpoint=marker.get("viewpoint").stringValue(),sha384=marker.get("sha384").stringValue(),blob=marker.get("blob").blobValue();
      assert(viewpoint!==null&&sha384!==null&&blob!==null);
      entries.push({flow,marker:{viewpoint,sha384,blob:new Uint8Array(blob)},offset:base+blob.byteOffset,length:blob.length});
    }
  }
  return entries;
}
export function entriesAt(bytes:Uint8Array):FlowMarker[]{return rangesAt(bytes).map(({flow,marker})=>({flow,marker}));}
export function markerAt(bytes:Uint8Array,flow:string,viewpoint?:string):Marker {
  const matches=entriesAt(bytes).filter(e=>e.flow===flow&&(viewpoint===undefined||e.marker.viewpoint===viewpoint));assert.equal(matches.length,1,"marker selector must identify one Viewpoint");return matches[0].marker;
}
export function deltasAt(bytes:Uint8Array):Deltas {const commands=tuples(bytes),last=commands.at(-1)!.tuple;return (commands.length===1?last.get(3).get("deltas"):last.get(3)).toObject() as Deltas;}
export function legacyDeltasAt(bytes:Uint8Array):Deltas<TursoDelta>{const deltas=deltasAt(bytes);for(const delta of Object.values(deltas.turso))assert("pages" in delta.physical);return deltas as Deltas<TursoDelta>;}
