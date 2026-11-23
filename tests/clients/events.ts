import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import { encode, toReference, type Reference } from "./flexbuffer";
import { all, at, readable, before, wrap, concat, nestedMessage, NESTED, MARGIN } from "./envbuf";
import { encode as lex } from "./lexidecimal";

export type Marker={viewpoint:string;sha384:string;blob:Uint8Array;edges:string[];context:Record<string,string>};
export type FlowMarker={flow:string;marker:Marker};
export type BlobRange=FlowMarker&{offset:number;length:number};
const namespace="sync.memoremix.com",command="sts/0/databasin/commitflow",ingest="sts/0/databasin/ingestturso";
export const manifestPath="sts/0/databasin/rangemanifest";
export type LogicalFrames={base:Uint8Array|null;header:Uint8Array;frames:Uint8Array[]};
export type TursoDelta={version:string;logical:LogicalFrames;physical:{before:string;after:string;size:number;pages:{number:number;data:Uint8Array}[]}};
export type WalDelta={version:string;logical:LogicalFrames;physical:{format:"sqlite-wal/1";base:string;milestone:string;parent:string|null;base_sha384:string|null;segments:Uint8Array[]}};
export type Deltas<D=TursoDelta|WalDelta>={turso:Record<string,D>};

export function encodeEvent(markers:Record<string,Marker>,deltas?:Deltas<TursoDelta>):Uint8Array {
  const owned:Record<string,Marker>=Object.create(null);
  for(const [flow,marker] of Object.entries(markers))owned[flow]={...marker,blob:new Uint8Array(marker.blob)};
  return encode([[Symbol.species,namespace,command,{markers:owned,...(deltas?{deltas}:{})}]]);
}
export function encodeTuples(commands:(unknown[]|{margin:Uint8Array})[],coordinate?:bigint):Uint8Array {
  const envelopes:Record<string,unknown>=Object.create(null),chunks:Uint8Array[]=[];let end=0,lastMargin:string|null=null;
  for(const tuple of commands){
    const margin=!Array.isArray(tuple),chunk=margin?wrap(tuple.margin,MARGIN):wrap(encode(tuple));end+=chunk.length;chunks.push(chunk);
    const key=lex(BigInt(end));
    if(margin){if(lastMargin!==null)delete envelopes[lastMargin];envelopes[key]=null;lastMargin=key;}
    else{envelopes[key]=tuple.slice(0,3);lastMargin=null;}
  }
  chunks.push(wrap(encode([Symbol.species,namespace,manifestPath,{envelopes,...(coordinate===undefined?{}:{coordinate})}])));return concat([wrap(concat(chunks),NESTED),wrap(new Uint8Array(8),MARGIN)]);
}
export function encodeWalEvent(commands:Record<string,Marker>[],delta:WalDelta):Uint8Array {
  return encodeTuples([...commands.map(markers=>[Symbol.species,namespace,command,{markers}]),[Symbol.species,namespace,ingest,{turso:{"default.turso":delta}}]]);
}
export function eventTuples(bytes:Uint8Array):unknown[][] {
  if(bytes[0]===0x65&&bytes[1]===0x6e&&bytes[2]===0x56)return readable(eventEnvelope(bytes).content).map(e=>toReference(new Uint8Array(e.content).buffer).toObject() as unknown[]).slice(0,-1);
  return toReference(new Uint8Array(bytes).buffer).toObject() as unknown[][];
}
function tuples(bytes:Uint8Array):{tuple:Reference;base:number}[] {
  let commands:{tuple:Reference;base:number}[];
  const enveloped=bytes[0]===0x65&&bytes[1]===0x6e&&bytes[2]===0x56;
  if(enveloped){
    const physical=all(eventEnvelope(bytes).content),frames=physical.filter(e=>e.format!==MARGIN);assert(frames.length>=2);
    assert.equal(physical.at(-1)!.end,frames.at(-1)!.end,"retry margin must be outside event envelope");
    const refs=frames.map(e=>{assert.equal(e.format,5);return toReference(new Uint8Array(e.content).buffer);});
    const manifest=refs.pop()!;assert.equal(manifest.get(0).symbolValue(),Symbol.species);assert.equal(manifest.get(1).stringValue(),namespace);assert.equal(manifest.get(2).stringValue(),manifestPath);
    const index=manifest.get(3).get("envelopes").toObject() as Record<string,unknown>;
    let expected=refs.length;
    for(let n=0;n<physical.length&&physical[n].start<frames.at(-1)!.start;n++){
      if(physical[n].format===MARGIN&&physical[n+1].format!==MARGIN){assert.equal(index[lex(BigInt(physical[n].end))],null);expected++;}
    }
    assert.equal(Object.keys(index).length,expected);
    for(let n=0;n<refs.length;n++)assert.deepEqual(index[lex(BigInt(frames[n].end))],[Symbol.species,namespace,refs[n].get(2).stringValue()]);
    commands=refs.map((tuple,n)=>({tuple,base:8+frames[n].contentStart}));
  }else{
    const root=toReference(new Uint8Array(bytes).buffer);assert(root.isVector()&&root.length()>0);
    commands=Array.from({length:root.length()},(_,n)=>({tuple:root.get(n),base:0}));
  }
  commands.forEach(({tuple},n)=>{assert(tuple.isVector()&&tuple.length()===4);assert.equal(tuple.get(0).symbolValue(),Symbol.species);assert.equal(tuple.get(1).stringValue(),namespace);const path=tuple.get(2).stringValue();if(n+1===commands.length&&(enveloped||commands.length>1))assert.equal(path,ingest);else assert(path===command||path==="sts/0/databasin/commitkernel");});return commands;
}
export function rangesAt(bytes:Uint8Array):BlobRange[] {
  const commands=tuples(bytes);if(commands.at(-1)?.tuple.get(2).stringValue()===ingest)commands.pop();const entries:BlobRange[]=[];
  for(const {tuple,base} of commands){
    if(tuple.get(2).stringValue()!==command)continue;
    const markers=tuple.get(3).get("markers");assert(markers.isMap());
    for(const flow of Object.keys(markers.toObject() as object)){
      const marker=markers.get(flow),viewpoint=marker.get("viewpoint").stringValue(),sha384=marker.get("sha384").stringValue(),blob=marker.get("blob").blobValue();
      assert(viewpoint!==null&&sha384!==null&&blob!==null);
      const edges=marker.get("edges").toObject();assert(Array.isArray(edges)&&edges.every(e=>typeof e==="string"));
      const context=marker.get("context").toObject() as Record<string,string>;assert(context&&typeof context==="object"&&!Array.isArray(context)&&Object.values(context).every(v=>typeof v==="string"));
      entries.push({flow,marker:{viewpoint,sha384,blob:new Uint8Array(blob),edges,context},offset:base+blob.byteOffset,length:blob.length});
    }
  }
  return entries;
}
export function entriesAt(bytes:Uint8Array):FlowMarker[]{return rangesAt(bytes).map(({flow,marker})=>({flow,marker}));}
export function markerAt(bytes:Uint8Array,flow:string,viewpoint?:string):Marker {
  const matches=entriesAt(bytes).filter(e=>e.flow===flow&&(viewpoint===undefined||e.marker.viewpoint===viewpoint));assert.equal(matches.length,1,"marker selector must identify one Viewpoint");return matches[0].marker;
}
export function deltasAt(bytes:Uint8Array):Deltas {const commands=tuples(bytes),last=commands.at(-1)!.tuple;return (last.get(2).stringValue()===ingest?last.get(3):last.get(3).get("deltas")).toObject() as Deltas;}
export function legacyDeltasAt(bytes:Uint8Array):Deltas<TursoDelta>{const deltas=deltasAt(bytes);for(const delta of Object.values(deltas.turso))assert("pages" in delta.physical);return deltas as Deltas<TursoDelta>;}

export function commandFrames(bytes:Uint8Array) {
  return all(eventEnvelope(bytes).content).map(e=>({...e,start:e.start+8,contentStart:e.contentStart+8,end:e.end+8}));
}

export function eventEnvelope(bytes:Uint8Array) {
  const event=at(bytes,0);assert.equal(event.format,NESTED);
  let end=event.end;while(end<bytes.length){const margin=at(bytes,end);assert.equal(margin.format,MARGIN,"unexpected envelope after event");end=margin.end;}
  return event;
}
export function coordinateBytes(bytes:Uint8Array):Uint8Array {
  if(!(bytes[0]===0x65&&bytes[1]===0x6e&&bytes[2]===0x56))return bytes;
  const event=eventEnvelope(bytes);return event.end===bytes.length?bytes:bytes.subarray(0,event.end);
}
export function manifestRange(bytes:Uint8Array):{start:number;end:number}|null {
  if(!(bytes[0]===0x65&&bytes[1]===0x6e&&bytes[2]===0x56))return null;
  const event=eventEnvelope(bytes),frame=before(event.content,event.content.length);
  assert.equal(frame.format,5,"event must end with rangemanifest");assert.equal(toReference(new Uint8Array(frame.content).buffer).get(2).stringValue(),manifestPath);
  return {start:frame.start+8,end:frame.end+8};
}
export function entryDigest(bytes:Uint8Array):string {return createHash("sha384").update(coordinateBytes(bytes)).digest("hex");}
export function coordinateLength(bytes:Uint8Array):number {return coordinateBytes(bytes).length;}
export function trimRetryMargins(bytes:Uint8Array):Uint8Array {eventEnvelope(bytes);return coordinateBytes(bytes);}
