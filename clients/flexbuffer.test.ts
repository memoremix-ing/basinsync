import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Builder, encode, toObject, toReference, VT_BLOB, VT_VECTOR_UINT } from "./flexbuffer";
import { WELL_KNOWN_BY_NAME } from "./symbols";

const rootType = (wire: Uint8Array) => wire[wire.length - 2] >> 2;
const payload = (wire: Uint8Array) => {
  const root = toReference(wire);
  return Array.from({ length: root.length() }, (_, i) => Number(root.get(i).intValue()));
};
const rawExtension = (bytes: number[]) => new Uint8Array([bytes.length, ...bytes, bytes.length, 48, 1]);

test.each([
  [0n, [0x78, 0]], [256n, [0x78, 1, 0]],
  [-1n, [0x7e, 0]], [-16n, [0x7e, 15]], [-257n, [0x7e, 1, 0]],
] as const)("bigint %s uses a single-byte extension prefix", (value, expected) => {
  const wire = encode(value);
  expect(rootType(wire)).toBe(VT_VECTOR_UINT);
  expect(payload(wire)).toEqual([...expected]);
  expect(toObject<bigint>(wire)).toBe(value);
});

test("interoperates with Rust extension wire vectors", () => {
  for (const [value, bytes] of [
    [0n, [2, 120, 0, 2, 48, 1]],
    [-1n, [2, 126, 0, 2, 48, 1]],
    [-257n, [3, 126, 1, 0, 3, 48, 1]],
    [Symbol.species, [8, 35, 115, 112, 101, 99, 105, 101, 115, 8, 48, 1]],
    [Symbol.for(""), [1, 36, 1, 48, 1]],
  ] as const) {
    const wire = new Uint8Array(bytes);
    expect(encode(value)).toEqual(wire);
    expect(toObject<typeof value>(wire)).toBe(value);
  }
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
  for (const name of ["dispose", "constructor", "__proto__", "match"]) {
    expect(() => toObject(rawExtension([...new TextEncoder().encode(`#${name}`)]))).toThrow();
  }
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

test("rejects invalid extension payloads", () => {
  for (const bytes of [[], [88, 0], [126], [120, 0, 1], [36, 255]]) {
    expect(() => toObject(rawExtension(bytes))).toThrow();
  }
  expect(() => toObject(new Uint8Array([2, 0, 120, 0, 0, 1, 4, 49, 1]))).toThrow();
  expect(toReference(encode(-1n)).isBigint()).toBe(true);
});
