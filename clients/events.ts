import assert from "node:assert/strict";
import { encode, toReference, type Reference } from "./flexbuffer";

export type Marker = { viewpoint: string; sha384: string; blob: Uint8Array };
export type FlowMarker = {flow:string;marker:Marker};
const namespace = "sync.memoremix.com";
const command = "sts/0/databasin/commitflow";
const ingest = "sts/0/databasin/ingestturso";
export type LogicalFrames={base:Uint8Array|null;header:Uint8Array;frames:Uint8Array[]};
export type TursoDelta={version:string;logical:LogicalFrames;physical:{before:string;after:string;size:number;pages:{number:number;data:Uint8Array}[]}};
export type WalDelta={version:string;logical:LogicalFrames;physical:{format:"sqlite-wal/1";base:string;milestone:string;parent:string|null;base_sha384:string|null;segments:Uint8Array[]}};
export type Deltas<D=TursoDelta|WalDelta>={turso:Record<string,D>};

export function encodeEvent(markers:Record<string,Marker>,deltas?:Deltas<TursoDelta>):Uint8Array {
  const owned:Record<string,Marker>=Object.create(null);
  for(const [flow,marker] of Object.entries(markers))owned[flow]={...marker,blob:new Uint8Array(marker.blob)};
  return encode([[Symbol.species,namespace,command,{markers:owned,...(deltas?{deltas}:{})}]]);
}
export function encodeWalEvent(commands:Record<string,Marker>[],delta:WalDelta):Uint8Array {
  return encode([...commands.map(markers=>[Symbol.species,namespace,command,{markers}]),[Symbol.species,namespace,ingest,{turso:{"default.turso":delta}}]]);
}
function tuples(bytes:Uint8Array):Reference[] {
  const root=toReference(new Uint8Array(bytes).buffer);
  assert(root.isVector() && root.length()>0);
  return Array.from({length:root.length()},(_,n)=>{
    const tuple=root.get(n);assert(tuple.isVector() && tuple.length()===4);
    assert.equal(tuple.get(0).symbolValue(),Symbol.species);assert.equal(tuple.get(1).stringValue(),namespace);
    assert.equal(tuple.get(2).stringValue(),n+1===root.length() && root.length()>1?ingest:command);
    return tuple;
  });
}
export function entriesAt(bytes:Uint8Array):FlowMarker[] {
  const commands=tuples(bytes);if(commands.length>1)commands.pop();
  const entries:FlowMarker[]=[];
  for(const tuple of commands){
    const markers=tuple.get(3).get("markers");assert(markers.isMap());
    for(const flow of Object.keys(markers.toObject() as object)){
      const marker=markers.get(flow);
      const viewpoint=marker.get("viewpoint").stringValue(),sha384=marker.get("sha384").stringValue(),blob=marker.get("blob").blobValue();
      assert(viewpoint!==null && sha384!==null && blob!==null);
      entries.push({flow,marker:{viewpoint,sha384,blob:new Uint8Array(blob)}});
    }
  }
  return entries;
}
export function markerAt(bytes:Uint8Array,flow:string,viewpoint?:string):Marker {
  const matches=entriesAt(bytes).filter(e=>e.flow===flow && (viewpoint===undefined || e.marker.viewpoint===viewpoint));
  assert.equal(matches.length,1,"marker selector must identify one Viewpoint");return matches[0].marker;
}
export function deltasAt(bytes:Uint8Array):Deltas {
  const commands=tuples(bytes),last=commands.at(-1)!;
  return (commands.length===1?last.get(3).get("deltas"):last.get(3)).toObject() as Deltas;
}
export function legacyDeltasAt(bytes:Uint8Array):Deltas<TursoDelta> {
  const deltas=deltasAt(bytes);for(const delta of Object.values(deltas.turso))assert("pages" in delta.physical);
  return deltas as Deltas<TursoDelta>;
}
