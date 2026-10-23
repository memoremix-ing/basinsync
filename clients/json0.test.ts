import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { parse, stringify } from "./json0";

describe("JSON0", () => {
  test.each(["", "0", "00", "0x1", "0~f", "0*AA", "0$shared", "0#iterator", "ordinary 🌎"])(
    "round-trips the literal string %s", (value) => {
      expect(parse<typeof value>(stringify(value))).toBe(value);
    },
  );

  test.each([
    [0n, "0x0"], [256n, "0x100"], [-1n, "0~0"], [-16n, "0~f"], [-257n, "0~100"],
  ] as const)("interoperates with the bigint %s as %s", (value, wire) => {
    expect(JSON.parse(stringify(value))).toBe(wire);
    expect(parse<bigint>(JSON.stringify(wire))).toBe(value);
  });

  test("round-trips arbitrary signed bigints", () => {
    for (let width = 1; width <= 256; width++) {
      const value = BigInt(`0x${randomBytes(width).toString("hex")}`);
      expect(parse<typeof value>(stringify(value))).toBe(value);
      expect(parse<bigint>(stringify(~value))).toBe(~value);
    }
  });

  test("escapes values but preserves object keys", () => {
    const value = { "0x1": ["0x1", 1n, -16n, Symbol.iterator, Symbol.for("shared")] };
    expect(parse<typeof value>(stringify(value))).toStrictEqual(value);
  });

  test("encodes only a view's bytes, including DataView and Buffer", () => {
    const storage = new Uint8Array([99, 0, 255, 99]);
    expect(stringify(storage.subarray(1, 3))).toBe('"0*AP8"');
    expect(parse<Uint8Array>('"0%AP8="')).toStrictEqual(new Uint8Array([0, 255]));
    for (const view of [new DataView(storage.buffer, 1, 2), Buffer.from(storage.buffer, 1, 2)]) {
      expect(parse<Uint8Array>(stringify(view))).toStrictEqual(new Uint8Array([0, 255]));
    }
  });

  test.each(["0?unknown", "0#unknown", "0~", "0x", "0~not-hex"])(
    "rejects the invalid extension %s", (value) => {
      expect(() => parse(JSON.stringify(value))).toThrow();
    },
  );

  test("round-trips supported well-known and global symbols", () => {
    for (const symbol of [Symbol.iterator, Symbol.asyncIterator, Symbol.unscopables, Symbol.for(""), Symbol.for("shared 🌎")]) {
      expect(parse<symbol>(stringify(symbol))).toBe(symbol);
    }
  });

  test.each(["dispose", "asyncDispose"] as const)("excludes Symbol.%s", (name) => {
    expect(() => stringify(Symbol[name])).toThrow("Unrecognized symbol.");
    expect(() => parse(JSON.stringify(`0#${name}`))).toThrow("Unrecognized symbol encoding.");
  });

  test("rejects local symbols", () => {
    expect(() => stringify(Symbol("local"))).toThrow("Unrecognized symbol.");
  });
});
