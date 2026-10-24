import assert from "node:assert/strict";
import { encode, toReference, type Reference } from "./flexbuffer";

export type Marker = { viewpoint: string; sha384: string; blob: Uint8Array };
const namespace = "sync.memoremix.com";
const command = "sts/0/databasin/commitflow";

export type TursoDelta = {
  version: string;
  logical: { base: Uint8Array | null; header: Uint8Array; frames: Uint8Array[] };
  physical: { before: string; after: string; size: number; pages: {number: number; data: Uint8Array}[] };
};
export type Deltas = { turso: Record<string, TursoDelta> };

export function encodeEvent(markers: Record<string, Marker>, deltas?: Deltas): Uint8Array {
  const owned: Record<string, Marker> = Object.create(null);
  for (const [flow, marker] of Object.entries(markers)) {
    // The JS builder uses the whole ArrayBuffer of a view; give it an exact copy.
    owned[flow] = { ...marker, blob: new Uint8Array(marker.blob) };
  }
  return encode([[Symbol.species, namespace, command, { markers: owned, ...(deltas ? { deltas } : {}) }]]);
}

function get(map: Reference, key: string): Reference {
  return map.get(key);
}
export function markerAt(bytes: Uint8Array, flow: string): Marker {
  const root = toReference(new Uint8Array(bytes).buffer);
  assert(root.isVector() && root.length() === 1);
  const tuple = root.get(0);
  assert(tuple.isVector() && tuple.length() === 4);
  assert.equal(tuple.get(0).symbolValue(), Symbol.species);
  assert.equal(tuple.get(1).stringValue(), namespace);
  assert.equal(tuple.get(2).stringValue(), command);
  const markers = get(tuple.get(3), "markers");
  assert(markers.isMap());
  const marker = get(markers, flow);
  const viewpoint = get(marker, "viewpoint").stringValue();
  const sha384 = get(marker, "sha384").stringValue();
  const blob = get(marker, "blob").blobValue();
  assert(viewpoint !== null && sha384 !== null && blob !== null);
  return { viewpoint, sha384, blob: new Uint8Array(blob) };
}

export function deltasAt(bytes: Uint8Array): Deltas {
  return toReference(new Uint8Array(bytes).buffer).get(0).get(3).get("deltas").toObject() as Deltas;
}
