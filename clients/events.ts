import assert from "node:assert/strict";
import { encode, toReference } from "flatbuffers/js/flexbuffers.js";
import type { Reference } from "flatbuffers/js/flexbuffers/reference.js";

export type Marker = { viewpoint: string; sha384: string; blob: Uint8Array };
const namespace = "sync.memoremix.com";
const command = "sts/0/databasin/commitflow";

export function encodeEvent(markers: Record<string, Marker>): Uint8Array {
  const owned: Record<string, Marker> = Object.create(null);
  for (const [flow, marker] of Object.entries(markers)) {
    // The JS builder uses the whole ArrayBuffer of a view; give it an exact copy.
    owned[flow] = { ...marker, blob: new Uint8Array(marker.blob) };
  }
  return encode([[namespace, command, { markers: owned }]]);
}

// flatbuffers 25.9's declaration omits the implemented string-key overload.
function get(map: Reference, key: string): Reference {
  return (map as unknown as { get(key: string): Reference }).get(key);
}
export function markerAt(bytes: Uint8Array, flow: string): Marker {
  const root = toReference(new Uint8Array(bytes).buffer);
  assert(root.isVector() && root.length() === 1);
  const tuple = root.get(0);
  assert(tuple.isVector() && tuple.length() === 3);
  assert.equal(tuple.get(0).stringValue(), namespace);
  assert.equal(tuple.get(1).stringValue(), command);
  const markers = get(tuple.get(2), "markers");
  assert(markers.isMap());
  const marker = get(markers, flow);
  const viewpoint = get(marker, "viewpoint").stringValue();
  const sha384 = get(marker, "sha384").stringValue();
  const blob = get(marker, "blob").blobValue();
  assert(viewpoint !== null && sha384 !== null && blob !== null);
  return { viewpoint, sha384, blob: new Uint8Array(blob) };
}
