import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Builder, encode, toObject, toReference, VT_BLOB, VT_VECTOR_UINT } from "./flexbuffer";
import { WELL_KNOWN_BY_NAME } from "./symbols";
import { vectors } from "./vectors";

const rootType = (wire: Uint8Array) => wire[wire.length - 2] >> 2;
const payload = (wire: Uint8Array) => {
  const root = toReference(wire);
  return Array.from({ length: root.length() }, (_, i) => Number(root.get(i).intValue()));
};
const rawExtension = (bytes: number[]) => new Uint8Array([bytes.length, ...bytes, bytes.length, 48, 1]);

type Extension = {bigint?:string;wellKnownSymbol?:string;globalSymbol?:string;wire:number[]};
const shared = vectors<{extensions:Extension[];invalid:number[][];unsupportedWellKnownSymbols:string[]}>("flexbuffer");

test("shared extension vectors", () => {
  for (const {bigint, wellKnownSymbol, globalSymbol, wire} of shared.extensions) {
    const value = bigint !== undefined ? BigInt(bigint) : wellKnownSymbol !== undefined ? WELL_KNOWN_BY_NAME[wellKnownSymbol as keyof typeof WELL_KNOWN_BY_NAME] : Symbol.for(globalSymbol!);
    expect(encode(value)).toEqual(new Uint8Array(wire));
    expect(toObject<typeof value>(new Uint8Array(wire))).toBe(value);
  }
  for (const wire of shared.invalid) expect(() => toObject(new Uint8Array(wire))).toThrow();
  for (const name of shared.unsupportedWellKnownSymbols) expect(() => toObject(rawExtension([...new TextEncoder().encode(`#${name}`)]))).toThrow();
  expect(toReference(encode(-1n)).isBigint()).toBe(true);
});

test("round-trips arbitrary signed bigints in nested containers", () => {
  for (let width = 1; width <= 256; width++) {
    const value = BigInt(`0x${randomBytes(width).toString("hex")}`);
    const object = { values: [value, ~value] };
    expect(toObject<typeof object>(encode(object))).toEqual(object);
  }
});

test("uses # and $ for the shared well-known and global symbol sets", () => {
  for (const [name, value] of Object.entries(WELL_KNOWN_BY_NAME)) {
    const wire = encode(value);
    expect(rootType(wire)).toBe(VT_VECTOR_UINT);
    expect(payload(wire)).toEqual([...new TextEncoder().encode(`#${name}`)]);
    expect(toObject<symbol>(wire)).toBe(value);
  }
  for (const name of ["", "shared 🌎", "large ".repeat(100), "x".repeat(65536)]) {
    const wire = encode(Symbol.for(name));
    expect(payload(wire)).toEqual([...new TextEncoder().encode(`$${name}`)]);
    expect(toObject<symbol>(wire)).toBe(Symbol.for(name));
  }
  expect(() => encode(Symbol("local"))).toThrow();
});

test("ordinary unsigned vectors never use the extension type", () => {
  for (const length of [0, 1, 2, 3, 4, 5, 256]) {
    const values = Array.from({ length }, (_, i) => i === 0 ? 120 : i);
    const builder = new Builder();
    builder.startVector();
    for (const value of values) builder.addUInt(value);
    builder.end();
    const wire = builder.finish();
    expect(rootType(wire)).not.toBe(VT_VECTOR_UINT);
    expect(toObject<number[]>(wire)).toEqual(values);
  }
});

test("keeps blobs exact and map keys prototype-safe", () => {
  const backing = new Uint8Array([99, 0, 255, 128, 99]);
  const bytes = backing.subarray(1, 4);
  expect(rootType(encode(bytes))).toBe(VT_BLOB);
  expect(toObject<Uint8Array>(encode(bytes))).toEqual(new Uint8Array([0, 255, 128]));
  const object = { ["__proto__"]: { value: 1n }, constructor: Symbol.species };
  expect(toObject<typeof object>(encode(object))).toEqual(object);
});

test("orders map keys by UTF-8 bytes and rejects nonportable map text",()=>{
 const value={"\uffff":1,"\u{10000}":2};expect(toObject<typeof value>(encode(value))).toEqual(value);expect(toReference(encode(value)).get("\u{10000}").intValue()).toBe(2);expect(()=>encode({["bad\0key"]:1})).toThrow();expect(()=>encode("\ud800")).toThrow();
});
