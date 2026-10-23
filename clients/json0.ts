// JSON0 Dialect

import { WELL_KNOWN, WELL_KNOWN_BY_NAME } from "./symbols";

export const replacer = function (
  this: Record<string, unknown>,
  key: string,
  value: unknown,
): unknown {
  const original = this[key];
  // Node.js Buffer objects become ordinary objects containing a type and data field
  if (ArrayBuffer.isView(original)) {
    const bytes = new Uint8Array(
      original.buffer,
      original.byteOffset,
      original.byteLength,
    );

    return `0*${bytes.toBase64({
      alphabet: "base64url",
      omitPadding: true,
    })}`;
  }

  switch (typeof value) {
    default: {
      return value;
    }

    case "string": {
      return value.length > 1 && value.codePointAt(0) === 0x30 // "0".codePointAt
        ? `0${value}`
        : value;
    }

    case "bigint": {
      return value < 0n
        ? `0~${(~value).toString(16)}`
        : `0x${value.toString(16)}`;
    }

    case "symbol": {
      const text = WELL_KNOWN[value];
      if (text) return `0#${text}`;

      const desc = value.description || "";
      if (value === Symbol.for(desc)) return `0$${desc}`;

      throw new Error("Unrecognized symbol.");
    }
  }
};

export const reviver = (_key: string, value: unknown): unknown => {
  if (typeof value !== "string" || value.length < 2) return value;
  if (value.codePointAt(0) !== 0x30) return value; // "0".codePointAt
  const point = value.codePointAt(1);

  switch (point) {
    default: {
      throw new Error("Invalid string encoding.");
    }

    // "*".codePointAt -- Uint8Array (url-safe)
    case 0x2a: {
      return Uint8Array.fromBase64(value.slice(2), {
        alphabet: "base64url",
      });
    }
    // "%".codePointAt -- Uint8Array
    case 0x25: {
      return Uint8Array.fromBase64(value.slice(2), {
        alphabet: "base64",
      });
    }

    // "x".codePointAt -- +bigint
    case 0x78:
    // "~".codePointAt -- ~bigint
    case 0x7e: {
      const bigint = BigInt(`0x${value.slice(2)}`);
      return point === 0x7e ? ~bigint : bigint;
    }

    // "#".codePointAt -- well-known symbol
    case 0x23: {
      const symbol = WELL_KNOWN_BY_NAME[value.slice(2)];
      if (typeof symbol === "symbol") return symbol;
      throw new Error("Unrecognized symbol encoding.");
    }
    // "$".codePointAt -- global symbol
    case 0x24: {
      return Symbol.for(value.slice(2));
    }

    // "0".codePointAt
    case 0x30: {
      return value.slice(1);
    }
  }
};

export const stringify = (value: unknown): string => {
  return JSON.stringify(value, replacer);
};

export const parse = <ValueT = unknown>(json: string): ValueT => {
  return JSON.parse(json, reviver) as ValueT;
};
