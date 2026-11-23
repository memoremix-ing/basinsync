import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { encode, decode } from "./diffuse16";
import { encodeEvent, markerAt } from "./events";
import { toReference } from "./flexbuffer";
import { sha384 } from "./client";
import { vectors } from "./vectors";

const shared = vectors<{canonical:[string,string][];invalid:string[]}>("diffuse16");

test("Diffuse16 shared vectors and arbitrary-precision round trips", () => {
  for (const [n, wire] of shared.canonical) { expect(encode(BigInt(n))).toBe(wire); expect(decode(wire)).toBe(BigInt(n)); }
  for (const bad of shared.invalid) expect(() => decode(bad)).toThrow();
  for (let i=0;i<256;i++) {
    const value=BigInt(`0x${randomBytes(200).toString("hex")}`);
    expect(decode(encode(value))).toBe(value);
    expect(decode(encode(~value))).toBe(~value);
  }
});

test("FlexBuffers uses a unary command vector and exact binary blobs", () => {
  const backing = new Uint8Array([11, 0, 255, 128, 99]);
  const blob = backing.subarray(1,4);
  for (const flow of ["雪/a", "__proto__", "constructor"]) {
    const marker = { viewpoint:"18446744073709551616", sha384:sha384(blob), edges:[],context:{}, blob };
    const bytes = encodeEvent({[flow]:marker});
    const tuple = toReference(bytes).get(0);
    expect(tuple.length()).toBe(4);
    expect(tuple.get(0).isSymbol()).toBe(true);
    expect(tuple.get(0).symbolValue()).toBe(Symbol.species);
    expect(markerAt(bytes,flow)).toEqual({...marker, blob:new Uint8Array([0,255,128])});
  }
});
