import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { encode, decode, key, fromKey } from "./diffuse16";
import { encodeEvent, markerAt } from "./events";
import { toReference } from "./flexbuffer";
import { sha384 } from "./client";

test("Diffuse16 reverses nibbles and scatters positive arbitrary-precision Milestones", () => {
  for (const [n, wire] of [[0n,"0w0z"],[1n,"0w1z"],[16n,"0w01z"],[27n,"0wb1z"],[256n,"0w001z"],[-1n,"0wfy"],[-16n,"0w0y"],[-17n,"0wfey"],[-256n,"0w00y"]] as const) {
    expect(encode(n)).toBe(wire); expect(decode(wire)).toBe(n);
  }
  for (let i=0;i<256;i++) {
    const value=BigInt(`0x${randomBytes(200).toString("hex")}`);
    expect(decode(encode(value))).toBe(value);
    expect(decode(encode(~value))).toBe(~value);
    expect(fromKey(key(value))).toBe(value);
  }
  expect(key(16n)<key(1n)).toBe(true);
  for (const wire of ["", "0wz", "0w00z", "0w10z", "0wFz", "0w-1z"]) expect(()=>decode(wire)).toThrow();
  expect(()=>key(0n)).toThrow();
});

test("FlexBuffers uses a unary command vector and exact binary blobs", () => {
  const backing = new Uint8Array([11, 0, 255, 128, 99]);
  const blob = backing.subarray(1,4);
  for (const flow of ["雪/a", "__proto__", "constructor"]) {
    const marker = { viewpoint:"18446744073709551616", sha384:sha384(blob), blob };
    const bytes = encodeEvent({[flow]:marker});
    const tuple = toReference(bytes).get(0);
    expect(tuple.length()).toBe(4);
    expect(tuple.get(0).isSymbol()).toBe(true);
    expect(tuple.get(0).symbolValue()).toBe(Symbol.species);
    expect(markerAt(bytes,flow)).toEqual({...marker, blob:new Uint8Array([0,255,128])});
  }
});
