/// <reference lib="dom" />

// Derived from Google FlatBuffers (Apache-2.0; see LICENSE).
// Modified for Basinsync extension values and reserved unsigned vectors.
import { WELL_KNOWN, WELL_KNOWN_BY_NAME } from "./symbols";

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/bit-width.ts
export const BW_8 = 0;
export const BW_16 = 1;
export const BW_32 = 2;
export const BW_64 = 3;

type BitWidth = typeof BW_8 | typeof BW_16 | typeof BW_32 | typeof BW_64;

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/bit-width-util.ts
function toByteWidth(bitWidth: BitWidth): number {
  return 1 << bitWidth;
}

function iwidth(value: number): BitWidth {
  if (value >= -128 && value <= 127) return BW_8;
  if (value >= -32768 && value <= 32767) return BW_16;
  if (value >= -2147483648 && value <= 2147483647) return BW_32;
  return BW_64;
}

function fwidth(value: number): BitWidth {
  return value === Math.fround(value) ? BW_32 : BW_64;
}

export const uwidth = function (value: number): BitWidth {
  if (value <= 255) return BW_8;
  if (value <= 65535) return BW_16;
  if (value <= 4294967295) return BW_32;
  return BW_64;
}

function fromByteWidth(value: number): BitWidth {
  if (value === 1) return BW_8;
  if (value === 2) return BW_16;
  if (value === 4) return BW_32;
  return BW_64;
}

function paddingSize(bufSize: number, scalarSize: number): number {
  return (~bufSize + 1) & (scalarSize - 1);
}

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/value-type.ts
export const VT_NULL = 0;
export const VT_INT = 1;
export const VT_UINT = 2;
export const VT_FLOAT = 3;
export const VT_KEY = 4;
export const VT_STRING = 5;
export const VT_INDIRECT_INT = 6;
export const VT_INDIRECT_UINT = 7;
export const VT_INDIRECT_FLOAT = 8;
export const VT_MAP = 9;
export const VT_VECTOR = 10;
export const VT_VECTOR_INT = 11;
// Reserved for extension payloads; ordinary unsigned vectors must not use this type.
export const VT_VECTOR_UINT = 12;
export const VT_VECTOR_FLOAT = 13;
export const VT_VECTOR_KEY = 14;
export const VT_VECTOR_STRING_DEPRECATED = 15;
export const VT_VECTOR_INT2 = 16;
export const VT_VECTOR_UINT2 = 17;
export const VT_VECTOR_FLOAT2 = 18;
export const VT_VECTOR_INT3 = 19;
export const VT_VECTOR_UINT3 = 20;
export const VT_VECTOR_FLOAT3 = 21;
export const VT_VECTOR_INT4 = 22;
export const VT_VECTOR_UINT4 = 23;
export const VT_VECTOR_FLOAT4 = 24;
export const VT_BLOB = 25;
export const VT_BOOL = 26;
export const VT_VECTOR_BOOL = 36;

type ValueType =
  | typeof VT_NULL
  | typeof VT_INT
  | typeof VT_UINT
  | typeof VT_FLOAT
  | typeof VT_KEY
  | typeof VT_STRING
  | typeof VT_INDIRECT_INT
  | typeof VT_INDIRECT_UINT
  | typeof VT_INDIRECT_FLOAT
  | typeof VT_MAP
  | typeof VT_VECTOR
  | typeof VT_VECTOR_INT
  | typeof VT_VECTOR_UINT
  | typeof VT_VECTOR_FLOAT
  | typeof VT_VECTOR_KEY
  | typeof VT_VECTOR_STRING_DEPRECATED
  | typeof VT_VECTOR_INT2
  | typeof VT_VECTOR_UINT2
  | typeof VT_VECTOR_FLOAT2
  | typeof VT_VECTOR_INT3
  | typeof VT_VECTOR_UINT3
  | typeof VT_VECTOR_FLOAT3
  | typeof VT_VECTOR_INT4
  | typeof VT_VECTOR_UINT4
  | typeof VT_VECTOR_FLOAT4
  | typeof VT_BLOB
  | typeof VT_BOOL
  | typeof VT_VECTOR_BOOL;

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/value-type-util.ts
function isInline(value: ValueType): boolean {
  return value === VT_BOOL ||
    value <= VT_FLOAT;
}

function isDirectNumber(value: ValueType): boolean {
  return value >= VT_INT &&
    value <= VT_FLOAT;
}

function isIndirectNumber(value: ValueType): boolean {
  return value >= VT_INDIRECT_INT &&
    value <= VT_INDIRECT_FLOAT;
}

function isTypedVectorElement(value: ValueType): boolean {
  return value === VT_BOOL ||
    (value >= VT_INT &&
      value <= VT_STRING);
}

function isTypedVector(value: ValueType): boolean {
  return value === VT_VECTOR_BOOL ||
    (value >= VT_VECTOR_INT &&
      value <= VT_VECTOR_STRING_DEPRECATED);
}

function isFixedTypedVector(value: ValueType): boolean {
  return value >= VT_VECTOR_INT2 &&
    value <= VT_VECTOR_FLOAT4;
}

function isAVector(value: ValueType): boolean {
  return isTypedVector(value) ||
    isFixedTypedVector(value) ||
    value === VT_VECTOR;
}

function toTypedVector(valueType: ValueType, length: number): ValueType {
  if (length === 0) return valueType - VT_INT + VT_VECTOR_INT as never;
  if (length === 2) return valueType - VT_INT + VT_VECTOR_INT2 as never;
  if (length === 3) return valueType - VT_INT + VT_VECTOR_INT3 as never;
  if (length === 4) return valueType - VT_INT + VT_VECTOR_INT4 as never;
  throw new Error(`Unexpected length ${length}`);
}

function typedVectorElementType(valueType: ValueType): ValueType {
  return valueType - VT_VECTOR_INT + VT_INT as never;
}

function fixedTypedVectorElementType(valueType: ValueType): ValueType {
  return ((valueType - VT_VECTOR_INT2) % 3) + VT_INT as never;
}

function fixedTypedVectorElementSize(valueType: ValueType): ValueType {
  // The x / y >> 0 trick is to have an int division. Suppose to be faster than Math.floor()
  return (((valueType - VT_VECTOR_INT2) / 3) >> 0) + 2 as never;
}

function packedType(valueType: ValueType, bitWidth: number): ValueType {
  return (bitWidth | (valueType << 2)) as never;
}

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/flexbuffers-util.ts
const decoder = new TextDecoder();
function fromUTF8Array(data: Uint8Array): string {
  return decoder.decode(data);
}

const encoder = new TextEncoder();
function toUTF8Array(str: string): Uint8Array {
  return encoder.encode(str);
}

function encodeExtendedValue(value: bigint | symbol): Uint8Array {
  if (typeof value === "bigint") {
    const negative = value < 0n;
    let magnitude = negative ? ~value : value;
    let byteLength = 1;
    for (let remaining = magnitude; remaining > 0xffn; remaining >>= 8n) {
      byteLength++;
    }

    const encoded = new Uint8Array(byteLength + 1);
    encoded[0] = negative ? 0x7e : 0x78;
    for (let index = byteLength; index > 0; index--) {
      encoded[index] = Number(magnitude & 0xffn);
      magnitude >>= 8n;
    }
    return encoded;
  }

  const wellKnownName = WELL_KNOWN[value];
  if (wellKnownName) return toUTF8Array(`#${wellKnownName}`);

  const description = value.description || "";
  if (value === Symbol.for(description)) return toUTF8Array(`$${description}`);

  throw new Error("Unrecognized symbol.");
}

function decodeExtendedValue(value: Uint8Array): bigint | symbol {
  const discriminator = value[0];

  if (discriminator === 0x78 || discriminator === 0x7e) {
    if (value.length < 2 || (value.length > 2 && value[1] === 0)) {
      throw new Error("Invalid bigint encoding.");
    }
    let bigint = 0n;
    for (const byte of value.subarray(1)) {
      bigint = (bigint << 8n) | BigInt(byte);
    }
    return discriminator === 0x7e ? ~bigint : bigint;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(1));
  if (discriminator === 0x23) {
    const symbol = WELL_KNOWN_BY_NAME[text];
    if (typeof symbol === "symbol") return symbol;
    throw new Error("Unrecognized symbol encoding.");
  }
  if (discriminator === 0x24) return Symbol.for(text);

  throw new Error("Invalid extended value encoding.");
}

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/stack-value.ts
class StackValue {
  constructor(
    private builder: Builder,
    public type: ValueType,
    public width: BitWidth, // number,
    public value: number | boolean | null = null,
    public offset: number = 0,
  ) {
    this.elementWidth = elementWidth;
    this.isOffset = isOffset;
    this.storedPackedType = storedPackedType;
    this.storedWidth = storedWidth;
    this.writeToBuffer = writeToBuffer;
  }

  elementWidth(size: number, index: number): BitWidth {
    if (isInline(this.type)) return this.width;
    for (let i = 0; i < 4; i++) {
      const width = 1 << i;
      const offsetLoc = size + paddingSize(size, width) + index * width;
      const offset = offsetLoc - this.offset;
      const bitWidth = uwidth(offset);
      if (1 << bitWidth === width) {
        return bitWidth;
      }
    }
    throw new Error(
      `Element is unknown. Size: ${size} at index: ${index}. This might be a bug. Please create an issue https://github.com/google/flatbuffers/issues/new`,
    );
  }

  writeToBuffer(byteWidth: number): void {
    const newOffset = this.builder.computeOffset(byteWidth);
    if (this.type === VT_FLOAT) {
      if (this.width === BW_32) {
        this.builder.view.setFloat32(
          this.builder.offset,
          this.value as number,
          true,
        );
      } else {
        this.builder.view.setFloat64(
          this.builder.offset,
          this.value as number,
          true,
        );
      }
    } else if (this.type === VT_INT) {
      const bitWidth = fromByteWidth(byteWidth);
      this.builder.pushInt(this.value as number, bitWidth);
    } else if (this.type === VT_UINT) {
      const bitWidth = fromByteWidth(byteWidth);
      this.builder.pushUInt(this.value as number, bitWidth);
    } else if (this.type === VT_NULL) {
      this.builder.pushInt(0, this.width);
    } else if (this.type === VT_BOOL) {
      this.builder.pushInt(this.value ? 1 : 0, this.width);
    } else {
      throw new Error(
        `Unexpected type: ${this.type}. This might be a bug. Please create an issue https://github.com/google/flatbuffers/issues/new`,
      );
    }
    this.offset = newOffset;
  }

  storedWidth(width: BitWidth = BW_8): BitWidth {
    return isInline(this.type)
      ? Math.max(width, this.width) as never
      : this.width;
  }

  storedPackedType(width: BitWidth = BW_8): ValueType {
    return packedType(this.type, this.storedWidth(width));
  }

  isOffset(): boolean {
    return !isInline(this.type);
  }
}

const {
  elementWidth,
  isOffset,
  storedPackedType,
  storedWidth,
  writeToBuffer,
} = StackValue.prototype;

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/builder.ts
interface StackPointer {
  stackPosition: number;
  isVector: boolean;
  presorted?: boolean;
}

class Builder {
  buffer: ArrayBuffer;
  view: DataView;

  readonly stack: Array<StackValue> = [];
  readonly stackPointers: Array<StackPointer> = [];
  offset = 0;
  finished = false;
  readonly stringLookup: Record<string, StackValue> = {};
  readonly keyLookup: Record<string, StackValue> = {};
  readonly keyVectorLookup: Record<string, StackValue> = {};
  readonly indirectIntLookup: Record<number, StackValue> = {};
  readonly indirectUIntLookup: Record<number, StackValue> = {};
  readonly indirectFloatLookup: Record<number, StackValue> = {};

  constructor(
    size = 2048,
    private dedupStrings = true,
    private dedupKeys = true,
    private dedupKeyVectors = true,
  ) {
    this.buffer = new ArrayBuffer(size > 0 ? size : 2048);
    this.view = new DataView(this.buffer);

    this.add = add;
    this.addFloat = addFloat;
    this.addInt = addInt;
    this.addKey = addKey;
    this.addUInt = addUInt;
    this.$align = $align;
    this.$boolStackValue = $boolStackValue;
    this.computeOffset = computeOffset;
    this.$createVector = $createVector;
    this.end = end;
    this.$endMap = $endMap;
    this.$endVector = $endVector;
    this.finish = finish;
    this.$finishBuffer = $finishBuffer;
    this.$floatStackValue = $floatStackValue;
    this.$intStackValue = $intStackValue;
    this.$integrityCheckOnKeyAddition = $integrityCheckOnKeyAddition;
    this.$integrityCheckOnValueAddition = $integrityCheckOnValueAddition;
    this.isFinished = isFinished;
    this.$nullStackValue = $nullStackValue;
    this.$offsetStackValue = $offsetStackValue;
    this.pushInt = pushInt;
    this.pushUInt = pushUInt;
    this.$sort = $sort;
    this.startMap = startMap;
    this.startVector = startVector;
    this.$uintStackValue = $uintStackValue;
    this.$writeBlob = $writeBlob;
    this.$writeInt = $writeInt;
    this.$writeKey = $writeKey;
    this.$writeStackValue = $writeStackValue;
    this.$writeString = $writeString;
    this.$writeUInt = $writeUInt;
  }

  // private
  $align(width: BitWidth) {
    const byteWidth = toByteWidth(width);
    this.offset += paddingSize(this.offset, byteWidth);
    return byteWidth;
  }

  computeOffset(newValueSize: number): number {
    const targetOffset = this.offset + newValueSize;
    let size = this.buffer.byteLength;
    const prevSize = size;
    while (size < targetOffset) {
      size <<= 1;
    }
    if (prevSize < size) {
      const prevBuffer = this.buffer;
      this.buffer = new ArrayBuffer(size);
      this.view = new DataView(this.buffer);
      new Uint8Array(this.buffer).set(new Uint8Array(prevBuffer), 0);
    }
    return targetOffset;
  }

  pushInt(value: number, width: BitWidth): void {
    if (width === BW_8) {
      this.view.setInt8(this.offset, value);
    } else if (width === BW_16) {
      this.view.setInt16(this.offset, value, true);
    } else if (width === BW_32) {
      this.view.setInt32(this.offset, value, true);
    } else if (width === BW_64) {
      this.view.setBigInt64(this.offset, BigInt(value), true);
    } else {
      throw new Error(`Unexpected width: ${width} for value: ${value}`);
    }
  }

  pushUInt(value: number, width: BitWidth): void {
    if (width === BW_8) {
      this.view.setUint8(this.offset, value);
    } else if (width === BW_16) {
      this.view.setUint16(this.offset, value, true);
    } else if (width === BW_32) {
      this.view.setUint32(this.offset, value, true);
    } else if (width === BW_64) {
      this.view.setBigUint64(this.offset, BigInt(value), true);
    } else {
      throw new Error(`Unexpected width: ${width} for value: ${value}`);
    }
  }

  // private
  $writeInt(value: number, byteWidth: number) {
    const newOffset = this.computeOffset(byteWidth);
    this.pushInt(value, fromByteWidth(byteWidth));
    this.offset = newOffset;
  }

  // private
  $writeUInt(value: number, byteWidth: number) {
    const newOffset = this.computeOffset(byteWidth);
    this.pushUInt(value, fromByteWidth(byteWidth));
    this.offset = newOffset;
  }

  // private
  $writeBlob(view: ArrayBufferView) {
    const length = view.byteLength;
    const bitWidth = uwidth(length);
    const byteWidth = this.$align(bitWidth);
    this.$writeUInt(length, byteWidth);
    const blobOffset = this.offset;
    const newOffset = this.computeOffset(length);
    new Uint8Array(this.buffer).set(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      blobOffset,
    );
    this.stack.push(this.$offsetStackValue(blobOffset, VT_BLOB, bitWidth));
    this.offset = newOffset;
  }

  // private
  $writeString(str: string): void {
    if (
      this.dedupStrings &&
      Object.prototype.hasOwnProperty.call(this.stringLookup, str)
    ) {
      this.stack.push(this.stringLookup[str]);
      return;
    }
    const utf8 = toUTF8Array(str);
    const length = utf8.length;
    const bitWidth = uwidth(length);
    const byteWidth = this.$align(bitWidth);
    this.$writeUInt(length, byteWidth);
    const stringOffset = this.offset;
    const newOffset = this.computeOffset(length + 1);
    new Uint8Array(this.buffer).set(utf8, stringOffset);
    const stackValue = this.$offsetStackValue(stringOffset, VT_STRING, bitWidth);
    this.stack.push(stackValue);
    if (this.dedupStrings) {
      this.stringLookup[str] = stackValue;
    }
    this.offset = newOffset;
  }

  // private
  $writeKey(str: string): void {
    if (
      this.dedupKeys &&
      Object.prototype.hasOwnProperty.call(this.keyLookup, str)
    ) {
      this.stack.push(this.keyLookup[str]);
      return;
    }
    const utf8 = toUTF8Array(str);
    const length = utf8.length;
    const newOffset = this.computeOffset(length + 1);
    new Uint8Array(this.buffer).set(utf8, this.offset);
    const stackValue = this.$offsetStackValue(this.offset, VT_KEY, BW_8);
    this.stack.push(stackValue);
    if (this.dedupKeys) {
      this.keyLookup[str] = stackValue;
    }
    this.offset = newOffset;
  }

  // private
  $writeStackValue(value: StackValue, byteWidth: number): void {
    const newOffset = this.computeOffset(byteWidth);
    if (value.isOffset()) {
      const relativeOffset = this.offset - value.offset;
      if (
        byteWidth === 8 ||
        BigInt(relativeOffset) < (BigInt(1) << BigInt(byteWidth * 8))
      ) {
        this.$writeUInt(relativeOffset, byteWidth);
      } else {
        throw new Error(
          `Unexpected size ${byteWidth}. This might be a bug. Please create an issue https://github.com/google/flatbuffers/issues/new`,
        );
      }
    } else {
      value.writeToBuffer(byteWidth);
    }
    this.offset = newOffset;
  }

  // private
  $integrityCheckOnValueAddition() {
    if (this.finished) {
      throw new Error("Adding values after finish is prohibited");
    }
    if (
      this.stackPointers.length !== 0 &&
      this.stackPointers[this.stackPointers.length - 1].isVector === false
    ) {
      if (this.stack[this.stack.length - 1].type !== VT_KEY) {
        throw new Error(
          "Adding value to a map before adding a key is prohibited",
        );
      }
    }
  }

  // private
  $integrityCheckOnKeyAddition() {
    if (this.finished) {
      throw new Error("Adding values after finish is prohibited");
    }
    if (
      this.stackPointers.length === 0 ||
      this.stackPointers[this.stackPointers.length - 1].isVector
    ) {
      throw new Error("Adding key before starting a map is prohibited");
    }
  }

  startVector(): void {
    this.stackPointers.push({
      stackPosition: this.stack.length,
      isVector: true,
    });
  }

  startMap(presorted = false): void {
    this.stackPointers.push({
      stackPosition: this.stack.length,
      isVector: false,
      presorted: presorted,
    });
  }

  // private
  $endVector(stackPointer: StackPointer) {
    const vecLength = this.stack.length - stackPointer.stackPosition;
    const vec = this.$createVector(stackPointer.stackPosition, vecLength, 1);
    this.stack.splice(stackPointer.stackPosition, vecLength);
    this.stack.push(vec);
  }

  // private
  $endMap(stackPointer: StackPointer) {
    if (!stackPointer.presorted) {
      this.$sort(stackPointer);
    }
    let keyVectorHash = "";
    for (let i = stackPointer.stackPosition; i < this.stack.length; i += 2) {
      keyVectorHash += `,${this.stack[i].offset}`;
    }
    const vecLength = (this.stack.length - stackPointer.stackPosition) >> 1;

    if (
      this.dedupKeyVectors &&
      !Object.prototype.hasOwnProperty.call(this.keyVectorLookup, keyVectorHash)
    ) {
      this.keyVectorLookup[keyVectorHash] = this.$createVector(
        stackPointer.stackPosition,
        vecLength,
        2,
      );
    }
    const keysStackValue = this.dedupKeyVectors
      ? this.keyVectorLookup[keyVectorHash]
      : this.$createVector(stackPointer.stackPosition, vecLength, 2);
    const valuesStackValue = this.$createVector(
      stackPointer.stackPosition + 1,
      vecLength,
      2,
      keysStackValue,
    );
    this.stack.splice(stackPointer.stackPosition, vecLength << 1);
    this.stack.push(valuesStackValue);
  }

  // private
  $sort(stackPointer: StackPointer) {
    const view = this.view;
    const stack = this.stack;

    function shouldFlip(v1: StackValue, v2: StackValue) {
      if (v1.type !== VT_KEY || v2.type !== VT_KEY) {
        throw new Error(
          `Stack values are not keys ${v1} | ${v2}. Check if you combined [addKey] with add... method calls properly.`,
        );
      }
      let c1, c2;
      let index = 0;
      do {
        c1 = view.getUint8(v1.offset + index);
        c2 = view.getUint8(v2.offset + index);
        if (c2 < c1) return true;
        if (c1 < c2) return false;
        index += 1;
      } while (c1 !== 0 && c2 !== 0);
      return false;
    }

    function swap(stack: Array<StackValue>, flipIndex: number, i: number) {
      if (flipIndex === i) return;
      const k = stack[flipIndex];
      const v = stack[flipIndex + 1];
      stack[flipIndex] = stack[i];
      stack[flipIndex + 1] = stack[i + 1];
      stack[i] = k;
      stack[i + 1] = v;
    }

    function selectionSort() {
      for (let i = stackPointer.stackPosition; i < stack.length; i += 2) {
        let flipIndex = i;
        for (let j = i + 2; j < stack.length; j += 2) {
          if (shouldFlip(stack[flipIndex], stack[j])) {
            flipIndex = j;
          }
        }
        if (flipIndex !== i) {
          swap(stack, flipIndex, i);
        }
      }
    }

    function smaller(v1: StackValue, v2: StackValue) {
      if (v1.type !== VT_KEY || v2.type !== VT_KEY) {
        throw new Error(
          `Stack values are not keys ${v1} | ${v2}. Check if you combined [addKey] with add... method calls properly.`,
        );
      }
      if (v1.offset === v2.offset) {
        return false;
      }
      let c1, c2;
      let index = 0;
      do {
        c1 = view.getUint8(v1.offset + index);
        c2 = view.getUint8(v2.offset + index);
        if (c1 < c2) return true;
        if (c2 < c1) return false;
        index += 1;
      } while (c1 !== 0 && c2 !== 0);
      return false;
    }

    function quickSort(left: number, right: number) {
      if (left < right) {
        const mid = left + ((right - left) >> 2) * 2;
        const pivot = stack[mid];
        let left_new = left;
        let right_new = right;

        do {
          while (smaller(stack[left_new], pivot)) {
            left_new += 2;
          }
          while (smaller(pivot, stack[right_new])) {
            right_new -= 2;
          }
          if (left_new <= right_new) {
            swap(stack, left_new, right_new);
            left_new += 2;
            right_new -= 2;
          }
        } while (left_new <= right_new);

        quickSort(left, right_new);
        quickSort(left_new, right);
      }
    }

    let sorted = true;
    for (
      let i = stackPointer.stackPosition; i < this.stack.length - 2; i += 2
    ) {
      if (shouldFlip(this.stack[i], this.stack[i + 2])) {
        sorted = false;
        break;
      }
    }

    if (!sorted) {
      if (this.stack.length - stackPointer.stackPosition > 40) {
        quickSort(stackPointer.stackPosition, this.stack.length - 2);
      } else {
        selectionSort();
      }
    }
  }

  end(): void {
    if (this.stackPointers.length < 1) return;
    const pointer = this.stackPointers.pop() as StackPointer;
    if (pointer.isVector) {
      this.$endVector(pointer);
    } else {
      this.$endMap(pointer);
    }
  }

  // private
  $createVector(
    start: number,
    vecLength: number,
    step: number,
    keys: StackValue | null = null,
    allowFixed = true,
  ) {
    let bitWidth = uwidth(vecLength);
    let prefixElements = 1;
    if (keys !== null) {
      const elemWidth = keys.elementWidth(this.offset, 0);
      if (elemWidth > bitWidth) {
        bitWidth = elemWidth;
      }
      prefixElements += 2;
    }
    let vectorType: ValueType = VT_KEY;
    let typed = keys === null;
    for (let i = start; i < this.stack.length; i += step) {
      const elemWidth = this.stack[i].elementWidth(
        this.offset,
        i + prefixElements,
      );
      if (elemWidth > bitWidth) {
        bitWidth = elemWidth;
      }
      if (i === start) {
        vectorType = this.stack[i].type;
        typed = typed && isTypedVectorElement(vectorType);
      } else {
        if (vectorType !== this.stack[i].type) {
          typed = false;
        }
      }
    }
    const byteWidth = this.$align(bitWidth);
    const fix = allowFixed && typed && isDirectNumber(vectorType) &&
      vecLength >= 2 &&
      vecLength <= 4;
    // Only the extension writer may emit the variable-length uint vector type.
    if (vectorType === VT_UINT && !fix) typed = false;
    if (keys !== null) {
      this.$writeStackValue(keys, byteWidth);
      this.$writeUInt(1 << keys.width, byteWidth);
    }
    if (!fix) {
      this.$writeUInt(vecLength, byteWidth);
    }
    const vecOffset = this.offset;
    for (let i = start; i < this.stack.length; i += step) {
      this.$writeStackValue(this.stack[i], byteWidth);
    }
    if (!typed) {
      for (let i = start; i < this.stack.length; i += step) {
        this.$writeUInt(this.stack[i].storedPackedType(), 1);
      }
    }
    if (keys !== null) {
      return this.$offsetStackValue(vecOffset, VT_MAP, bitWidth);
    }
    if (typed) {
      const vType = toTypedVector(vectorType, fix ? vecLength : 0);
      return this.$offsetStackValue(vecOffset, vType, bitWidth);
    }
    return this.$offsetStackValue(vecOffset, VT_VECTOR, bitWidth);
  }

  // private
  $nullStackValue() {
    return new StackValue(this, VT_NULL, BW_8);
  }

  // private
  $boolStackValue(value: boolean) {
    return new StackValue(this, VT_BOOL, BW_8, value);
  }

  // private
  $intStackValue(value: number) {
    return new StackValue(this, VT_INT, iwidth(value), value as number);
  }

  // private
  $uintStackValue(value: number) {
    return new StackValue(this, VT_UINT, uwidth(value), value);
  }

  // private
  $writeExtendedValue(value: bigint | symbol): void {
    const encoded = encodeExtendedValue(value);
    const bitWidth = uwidth(encoded.length);
    const byteWidth = this.$align(bitWidth);
    this.$writeUInt(encoded.length, byteWidth);
    const offset = this.offset;
    for (const byte of encoded) this.$writeUInt(byte, byteWidth);
    this.stack.push(this.$offsetStackValue(offset, VT_VECTOR_UINT, bitWidth));
  }

  //private
  $floatStackValue(value: number) {
    return new StackValue(this, VT_FLOAT, fwidth(value), value);
  }

  // private
  $offsetStackValue(
    offset: number,
    valueType: ValueType,
    bitWidth: BitWidth,
  ): StackValue {
    return new StackValue(this, valueType, bitWidth, null, offset);
  }

  // private
  $finishBuffer() {
    if (this.stack.length !== 1) {
      throw new Error(
        `Stack has to be exactly 1, but it is ${this.stack.length}. You have to end all started vectors and maps before calling [finish]`,
      );
    }
    const value = this.stack[0];
    const byteWidth = this.$align(value.elementWidth(this.offset, 0));
    this.$writeStackValue(value, byteWidth);
    this.$writeUInt(value.storedPackedType(), 1);
    this.$writeUInt(byteWidth, 1);
    this.finished = true;
  }

  add(
    value:
      | undefined
      | null
      | boolean
      | bigint
      | number
      | DataView
      | string
      | Array<unknown>
      | Record<string, unknown>
      | unknown,
  ): void {
    this.$integrityCheckOnValueAddition();
    if (typeof value === "undefined") {
      throw new Error("You need to provide a value");
    }
    if (value === null) {
      this.stack.push(this.$nullStackValue());
    } else if (typeof value === "boolean") {
      this.stack.push(this.$boolStackValue(value));
    } else if (typeof value === "bigint" || typeof value === "symbol") {
      this.$writeExtendedValue(value);
    } else if (typeof value == "number") {
      if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
        this.stack.push(this.$intStackValue(value));
      } else {
        this.stack.push(this.$floatStackValue(value));
      }
    } else if (ArrayBuffer.isView(value)) {
      this.$writeBlob(value);
    } else if (typeof value === "string" || value instanceof String) {
      this.$writeString(value as string);
    } else if (Array.isArray(value)) {
      this.startVector();
      for (let i = 0; i < value.length; i++) {
        this.add(value[i]);
      }
      this.end();
    } else if (typeof value === "object") {
      const properties = Object.getOwnPropertyNames(value).sort();
      this.startMap(true);
      for (let i = 0; i < properties.length; i++) {
        const key = properties[i];
        this.addKey(key);
        this.add((value as Record<string, unknown>)[key]);
      }
      this.end();
    } else {
      throw new Error(`Unexpected value input ${value}`);
    }
  }

  finish(): Uint8Array {
    if (!this.finished) {
      this.$finishBuffer();
    }
    const result = this.buffer.slice(0, this.offset);
    return new Uint8Array(result);
  }

  isFinished(): boolean {
    return this.finished;
  }

  addKey(key: string): void {
    this.$integrityCheckOnKeyAddition();
    this.$writeKey(key);
  }

  addInt(value: number, indirect = false, deduplicate = false): void {
    this.$integrityCheckOnValueAddition();
    if (!indirect) {
      this.stack.push(this.$intStackValue(value));
      return;
    }
    if (
      deduplicate &&
      Object.prototype.hasOwnProperty.call(this.indirectIntLookup, value)
    ) {
      this.stack.push(this.indirectIntLookup[value]);
      return;
    }
    const stackValue = this.$intStackValue(value);
    const byteWidth = this.$align(stackValue.width);
    const newOffset = this.computeOffset(byteWidth);
    const valueOffset = this.offset;
    stackValue.writeToBuffer(byteWidth);
    const stackOffset = this.$offsetStackValue(
      valueOffset,
      VT_INDIRECT_INT,
      stackValue.width,
    );
    this.stack.push(stackOffset);
    this.offset = newOffset;
    if (deduplicate) {
      this.indirectIntLookup[value] = stackOffset;
    }
  }

  addUInt(value: number, indirect = false, deduplicate = false): void {
    this.$integrityCheckOnValueAddition();
    if (!indirect) {
      this.stack.push(this.$uintStackValue(value));
      return;
    }
    if (
      deduplicate &&
      Object.prototype.hasOwnProperty.call(this.indirectUIntLookup, value)
    ) {
      this.stack.push(this.indirectUIntLookup[value]);
      return;
    }
    const stackValue = this.$uintStackValue(value);
    const byteWidth = this.$align(stackValue.width);
    const newOffset = this.computeOffset(byteWidth);
    const valueOffset = this.offset;
    stackValue.writeToBuffer(byteWidth);
    const stackOffset = this.$offsetStackValue(
      valueOffset,
      VT_INDIRECT_UINT,
      stackValue.width,
    );
    this.stack.push(stackOffset);
    this.offset = newOffset;
    if (deduplicate) {
      this.indirectUIntLookup[value] = stackOffset;
    }
  }

  addFloat(value: number, indirect = false, deduplicate = false): void {
    this.$integrityCheckOnValueAddition();
    if (!indirect) {
      this.stack.push(this.$floatStackValue(value));
      return;
    }
    if (
      deduplicate &&
      Object.prototype.hasOwnProperty.call(this.indirectFloatLookup, value)
    ) {
      this.stack.push(this.indirectFloatLookup[value]);
      return;
    }
    const stackValue = this.$floatStackValue(value);
    const byteWidth = this.$align(stackValue.width);
    const newOffset = this.computeOffset(byteWidth);
    const valueOffset = this.offset;
    stackValue.writeToBuffer(byteWidth);
    const stackOffset = this.$offsetStackValue(
      valueOffset,
      VT_INDIRECT_FLOAT,
      stackValue.width,
    );
    this.stack.push(stackOffset);
    this.offset = newOffset;
    if (deduplicate) {
      this.indirectFloatLookup[value] = stackOffset;
    }
  }
}

const {
  add,
  addFloat,
  addInt,
  addKey,
  addUInt,
  $align,
  $boolStackValue,
  computeOffset,
  $createVector,
  end,
  $endMap,
  $endVector,
  finish,
  $finishBuffer,
  $floatStackValue,
  $intStackValue,
  $integrityCheckOnKeyAddition,
  $integrityCheckOnValueAddition,
  isFinished,
  $nullStackValue,
  $offsetStackValue,
  pushInt,
  pushUInt,
  $sort,
  startMap,
  startVector,
  $uintStackValue,
  $writeBlob,
  $writeInt,
  $writeKey,
  $writeStackValue,
  $writeString,
  $writeUInt,
} = Builder.prototype;

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/reference-util.ts
// function validateOffset(dataView: DataView, offset: number, width: number): void {
//   if (dataView.byteLength <= offset + width || (offset & (toByteWidth(width) - 1)) !== 0) {
//     throw new Error(`Bad offset: ${offset}, width: ${width}`);
//   }
// }
function readInt(
  dataView: DataView,
  offset: number,
  width: number,
): number | bigint {
  if (width < 2) {
    if (width < 1) {
      return dataView.getInt8(offset);
    } else {
      return dataView.getInt16(offset, true);
    }
  } else {
    if (width < 3) {
      return dataView.getInt32(offset, true);
    } else {
      if (dataView.setBigInt64 === undefined) {
        return BigInt(dataView.getUint32(offset, true)) +
          (BigInt(dataView.getUint32(offset + 4, true)) << BigInt(32));
      }
      return dataView.getBigInt64(offset, true);
    }
  }
}

function readUInt(
  dataView: DataView,
  offset: number,
  width: number,
): number | bigint {
  if (width < 2) {
    if (width < 1) {
      return dataView.getUint8(offset);
    } else {
      return dataView.getUint16(offset, true);
    }
  } else {
    if (width < 3) {
      return dataView.getUint32(offset, true);
    } else {
      if (dataView.getBigUint64 === undefined) {
        return BigInt(dataView.getUint32(offset, true)) +
          (BigInt(dataView.getUint32(offset + 4, true)) << BigInt(32));
      }
      return dataView.getBigUint64(offset, true);
    }
  }
}

function readFloat(dataView: DataView, offset: number, width: number): number {
  if (width < BW_32) {
    throw new Error(`Bad width: ${width}`);
  }
  if (width === BW_32) {
    return dataView.getFloat32(offset, true);
  }
  return dataView.getFloat64(offset, true);
}

function indirect(dataView: DataView, offset: number, width: number): number {
  // https://github.com/google/flatbuffers/issues/8009
  // const step = readUInt(dataView, offset, width) as number;
  const step = Number(readUInt(dataView, offset, width));
  return offset - step;
}

function keyIndex(
  key: string,
  dataView: DataView,
  offset: number,
  parentWidth: number,
  byteWidth: number,
  length: number,
): number | null {
  const input = toUTF8Array(key);
  const keysVectorOffset = indirect(dataView, offset, parentWidth) -
    byteWidth * 3;
  const bitWidth = fromByteWidth(byteWidth);
  const indirectOffset = keysVectorOffset -
    Number(readUInt(dataView, keysVectorOffset, bitWidth));
  const _byteWidth = Number(
    readUInt(dataView, keysVectorOffset + byteWidth, bitWidth),
  );
  let low = 0;
  let high = length - 1;
  while (low <= high) {
    const mid = (high + low) >> 1;
    const dif = diffKeys(input, mid, dataView, indirectOffset, _byteWidth);
    if (dif === 0) return mid;
    if (dif < 0) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return null;
}

function diffKeys(
  input: Uint8Array,
  index: number,
  dataView: DataView,
  offset: number,
  width: number,
): number {
  const keyOffset = offset + index * width;
  const keyIndirectOffset = keyOffset -
    Number(readUInt(dataView, keyOffset, fromByteWidth(width)));
  for (let i = 0; i < input.length; i++) {
    const dif = input[i] - dataView.getUint8(keyIndirectOffset + i);
    if (dif !== 0) {
      return dif;
    }
  }
  return dataView.getUint8(keyIndirectOffset + input.length) === 0 ? 0 : -1;
}

function keyForIndex(
  index: number,
  dataView: DataView,
  offset: number,
  parentWidth: number,
  byteWidth: number,
): string {
  const keysVectorOffset = indirect(dataView, offset, parentWidth) -
    byteWidth * 3;
  const bitWidth = fromByteWidth(byteWidth);
  const indirectOffset = keysVectorOffset -
    Number(readUInt(dataView, keysVectorOffset, bitWidth));
  const _byteWidth = Number(
    readUInt(dataView, keysVectorOffset + byteWidth, bitWidth),
  );
  const keyOffset = indirectOffset + index * _byteWidth;
  const keyIndirectOffset = keyOffset -
    Number(readUInt(dataView, keyOffset, fromByteWidth(_byteWidth)));
  let length = 0;
  while (dataView.getUint8(keyIndirectOffset + length) !== 0) {
    length++;
  }
  return fromUTF8Array(
    new Uint8Array(dataView.buffer, keyIndirectOffset, length),
  );
}

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers/reference.ts
function toReference(buffer: ArrayBufferLike | ArrayBufferView): Reference {
  const dataView = ArrayBuffer.isView(buffer)
    ? new DataView(
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice()
        .buffer,
    )
    : new DataView(buffer);
  const len = dataView.byteLength;

  if (len < 3) {
    throw new Error("Buffer needs to be bigger than 3 bytes");
  }

  const byteWidth = dataView.getUint8(len - 1);
  const packedType = dataView.getUint8(len - 2);
  const parentWidth = fromByteWidth(byteWidth);
  const offset = len - byteWidth - 2;

  return new Reference(dataView, offset, parentWidth, packedType as never, "/");
}

function valueForIndexWithKey(
  index: number,
  key: string,
  dataView: DataView,
  offset: number,
  parentWidth: number,
  byteWidth: number,
  length: number,
  path: string,
): Reference {
  const _indirect = indirect(dataView, offset, parentWidth);
  const elementOffset = _indirect + index * byteWidth;
  const packedType = dataView.getUint8(_indirect + length * byteWidth + index);
  return new Reference(
    dataView,
    elementOffset,
    fromByteWidth(byteWidth),
    packedType as never,
    `${path}/${key}`,
  );
}

class Reference {
  private readonly byteWidth: number;
  private readonly valueType: ValueType;
  private _length = -1;
  constructor(
    private dataView: DataView,
    private offset: number = dataView.byteLength > 2
      ? dataView.byteLength - dataView.getUint8(dataView.byteLength - 1) - 2
      : -1,
    private parentWidth: number = dataView.byteLength > 2
      ? fromByteWidth(dataView.getUint8(dataView.byteLength - 1))
      : -1,
    private packedType: ValueType = dataView.byteLength > 2
      ? dataView.getUint8(dataView.byteLength - 2) as never
      : -1 as never,
    private path: string = "/",
  ) {
    if (dataView.byteLength < 3) {
      throw new Error("Buffer needs to be bigger than 3 bytes");
    }

    this.byteWidth = 1 << (packedType & 3);
    this.valueType = packedType >> 2 as never;

    this.blobValue = blobValue;
    this.bigintValue = bigintValue;
    this.boolValue = boolValue;
    this.floatValue = floatValue;
    this.get = get;
    this.intValue = intValue;
    this.isBlob = isBlob;
    this.isBigint = isBigint;
    this.isBool = isBool;
    this.isFloat = isFloat;
    this.isInt = isInt;
    this.isMap = isMap;
    this.isNull = isNull;
    this.isNumber = isNumber;
    this.isString = isString;
    this.isSymbol = isSymbol;
    this.isVector = isVector;
    this.length = sizeof;
    this.numericValue = numericValue;
    this.stringValue = stringValue;
    this.symbolValue = symbolValue;
    this.toObject = parse;
  }

  isNull(): boolean {
    return this.valueType === VT_NULL;
  }
  isNumber(): boolean {
    return isDirectNumber(this.valueType) || isIndirectNumber(this.valueType);
  }
  isFloat(): boolean {
    return VT_FLOAT === this.valueType || VT_INDIRECT_FLOAT === this.valueType;
  }
  isInt(): boolean {
    return this.isNumber() && !this.isFloat();
  }
  isString(): boolean {
    return VT_STRING === this.valueType || VT_KEY === this.valueType;
  }
  isBool(): boolean {
    return VT_BOOL === this.valueType;
  }
  isBlob(): boolean {
    return VT_BLOB === this.valueType;
  }
  isBigint(): boolean {
    if (this.valueType !== VT_VECTOR_UINT || this.length() === 0) return false;
    const discriminator = this.get(0).intValue();
    return discriminator === 0x78 || discriminator === 0x7e;
  }
  isSymbol(): boolean {
    if (this.valueType !== VT_VECTOR_UINT || this.length() === 0) return false;
    const discriminator = this.get(0).intValue();
    return discriminator === 0x23 || discriminator === 0x24;
  }
  isVector(): boolean {
    return isAVector(this.valueType);
  }
  isMap(): boolean {
    return VT_MAP === this.valueType;
  }

  boolValue(): boolean | null {
    if (this.isBool()) {
      return readInt(this.dataView, this.offset, this.parentWidth) > 0;
    }
    return null;
  }

  intValue(): number | null {
    if (this.valueType === VT_INT) {
      return Number(readInt(this.dataView, this.offset, this.parentWidth));
    }
    if (this.valueType === VT_UINT) {
      return Number(readUInt(this.dataView, this.offset, this.parentWidth));
    }
    if (this.valueType === VT_INDIRECT_INT) {
      return Number(
        readInt(
          this.dataView,
          indirect(this.dataView, this.offset, this.parentWidth),
          fromByteWidth(this.byteWidth),
        ),
      );
    }
    if (this.valueType === VT_INDIRECT_UINT) {
      return Number(
        readUInt(
          this.dataView,
          indirect(this.dataView, this.offset, this.parentWidth),
          fromByteWidth(this.byteWidth),
        ),
      );
    }
    return null;
  }

  floatValue(): number | null {
    if (this.valueType === VT_FLOAT) {
      return readFloat(this.dataView, this.offset, this.parentWidth);
    }
    if (this.valueType === VT_INDIRECT_FLOAT) {
      return readFloat(
        this.dataView,
        indirect(this.dataView, this.offset, this.parentWidth),
        fromByteWidth(this.byteWidth),
      );
    }
    return null;
  }

  numericValue(): number | null {
    return this.floatValue() ?? this.intValue();
  }

  stringValue(): string | null {
    if (this.valueType === VT_STRING || this.valueType === VT_KEY) {
      const begin = indirect(this.dataView, this.offset, this.parentWidth);
      return fromUTF8Array(
        new Uint8Array(this.dataView.buffer, begin, this.length()),
      );
    }
    return null;
  }

  blobValue(): Uint8Array | null {
    if (this.isBlob()) {
      const begin = indirect(this.dataView, this.offset, this.parentWidth);
      return new Uint8Array(this.dataView.buffer, begin, this.length());
    }
    return null;
  }

  bigintValue(): bigint | null {
    if (!this.isBigint()) return null;
    return decodeExtendedValue(this.$extendedValue()) as bigint;
  }

  symbolValue(): symbol | null {
    if (!this.isSymbol()) return null;
    return decodeExtendedValue(this.$extendedValue()) as symbol;
  }

  // private
  $extendedValue(): Uint8Array {
    const encoded = new Uint8Array(this.length());
    for (let index = 0; index < encoded.length; index++) {
      const byte = this.get(index).intValue();
      if (byte === null || byte < 0 || byte > 255) {
        throw new Error("Invalid extended value byte.");
      }
      encoded[index] = byte;
    }
    return encoded;
  }

  get(key: number | string): Reference {
    const length = this.length();
    if (
      typeof key === "number" && Number.isInteger(key) &&
      isAVector(this.valueType)
    ) {
      if (key >= length || key < 0) {
        throw new Error(
          `Key: [${key}] is not applicable on ${this.path} of ${this.valueType} length: ${length}`,
        );
      }
      const _indirect = indirect(this.dataView, this.offset, this.parentWidth);
      const elementOffset = _indirect + key * this.byteWidth;
      let _packedType: number;
      if (isTypedVector(this.valueType)) {
        const _valueType = typedVectorElementType(this.valueType);
        _packedType = packedType(_valueType, BW_8);
      } else if (isFixedTypedVector(this.valueType)) {
        const _valueType = fixedTypedVectorElementType(this.valueType);
        _packedType = packedType(_valueType, BW_8);
      } else {
        _packedType = this.dataView.getUint8(
          _indirect + length * this.byteWidth + key,
        );
      }
      return new Reference(
        this.dataView,
        elementOffset,
        fromByteWidth(this.byteWidth),
        _packedType as never,
        `${this.path}[${key}]`,
      );
    }
    if (typeof key === "string") {
      const index = keyIndex(
        key,
        this.dataView,
        this.offset,
        this.parentWidth,
        this.byteWidth,
        length,
      );
      if (index !== null) {
        return valueForIndexWithKey(
          index,
          key,
          this.dataView,
          this.offset,
          this.parentWidth,
          this.byteWidth,
          length,
          this.path,
        );
      }
    }
    throw new Error(
      `Key [${key}] is not applicable on ${this.path} of ${this.valueType}`,
    );
  }

  length(): number {
    // https://github.com/google/flatbuffers/issues/8009
    // let size;
    let size = 0;
    if (this._length > -1) {
      return this._length;
    }
    if (isFixedTypedVector(this.valueType)) {
      this._length = fixedTypedVectorElementSize(this.valueType);
    } else if (
      this.valueType === VT_BLOB ||
      this.valueType === VT_MAP ||
      isAVector(this.valueType)
    ) {
      // https://github.com/google/flatbuffers/issues/8009
      // this._length = readUInt(
      //   this.dataView,
      //   indirect(this.dataView, this.offset, this.parentWidth) - this.byteWidth,
      //   fromByteWidth(this.byteWidth),
      // ) as number;
      this._length = Number(
        readUInt(
          this.dataView,
          indirect(this.dataView, this.offset, this.parentWidth) - this.byteWidth,
          fromByteWidth(this.byteWidth),
        ),
      );
    } else if (this.valueType === VT_NULL) {
      this._length = 0;
    } else if (this.valueType === VT_STRING) {
      const _indirect = indirect(this.dataView, this.offset, this.parentWidth);
      let sizeByteWidth = this.byteWidth;
      // https://github.com/google/flatbuffers/issues/8009
      // size = readUInt(
      //   this.dataView,
      //   _indirect - sizeByteWidth,
      //   fromByteWidth(this.byteWidth),
      // );
      // while (this.dataView.getInt8(_indirect + (size as number)) !== 0) {
      //   sizeByteWidth <<= 1;
      //   size = readUInt(
      //     this.dataView,
      //     _indirect - sizeByteWidth,
      //     fromByteWidth(this.byteWidth),
      //   );
      // }
      // this._length = size as number;
      size = Number(
        readUInt(
          this.dataView,
          _indirect - sizeByteWidth,
          fromByteWidth(this.byteWidth),
        ),
      );
      while (this.dataView.getInt8(_indirect + size) !== 0) {
        sizeByteWidth <<= 1;
        size = Number(
          readUInt(
            this.dataView,
            _indirect - sizeByteWidth,
            fromByteWidth(this.byteWidth),
          ),
        );
      }
      this._length = size;
    } else if (this.valueType === VT_KEY) {
      const _indirect = indirect(this.dataView, this.offset, this.parentWidth);
      size = 1;
      while (this.dataView.getInt8(_indirect + size) !== 0) {
        size++;
      }
      this._length = size;
    } else {
      this._length = 1;
    }
    return Number(this._length);
  }

  toObject(): unknown {
    const length = this.length();
    if (this.isBigint()) {
      return this.bigintValue();
    }
    if (this.isSymbol()) {
      return this.symbolValue();
    }
    if (this.valueType === VT_VECTOR_UINT) {
      throw new Error("Invalid extended value encoding.");
    }
    if (this.isVector()) {
      const result = [];
      for (let i = 0; i < length; i++) {
        result.push(this.get(i).toObject());
      }
      return result;
    }
    if (this.isMap()) {
      const result: Record<string, unknown> = {};
      for (let i = 0; i < length; i++) {
        const key = keyForIndex(
          i,
          this.dataView,
          this.offset,
          this.parentWidth,
          this.byteWidth,
        );
        Object.defineProperty(result, key, { enumerable: true, writable: true, configurable: true, value: valueForIndexWithKey(
          i,
          key,
          this.dataView,
          this.offset,
          this.parentWidth,
          this.byteWidth,
          length,
          this.path,
        ).toObject() });
      }
      return result;
    }
    if (this.isNull()) {
      return null;
    }
    if (this.isBool()) {
      return this.boolValue();
    }
    if (this.isNumber()) {
      return this.numericValue();
    }
    return this.blobValue() || this.stringValue();
  }
}

const {
  blobValue,
  bigintValue,
  boolValue,
  floatValue,
  get,
  intValue,
  isBlob,
  isBigint,
  isBool,
  isFloat,
  isInt,
  isMap,
  isNull,
  isNumber,
  isString,
  isSymbol,
  isVector,
  length: sizeof,
  numericValue,
  stringValue,
  symbolValue,
  toObject: parse,
} = Reference.prototype;

// https://github.com/google/flatbuffers/blob/8a09f3fb0bff86ccc8cce4290b03d498fa59318a/ts/flexbuffers.ts
function builder(): Builder {
  return new Builder();
}

function toObject<ValueT = unknown>(
  buffer: ArrayBufferLike | ArrayBufferView,
): ValueT {
  return toReference(buffer).toObject() as ValueT;
}

function encode(
  object: unknown,
  size = 2048,
  deduplicateStrings = true,
  deduplicateKeys = true,
  deduplicateKeyVectors = true,
): Uint8Array {
  const builder = new Builder(
    size > 0 ? size : 2048,
    deduplicateStrings,
    deduplicateKeys,
    deduplicateKeyVectors,
  );

  builder.add(object);
  return builder.finish();
}

export {
  StackValue,
  Builder,
  Reference,
  builder,
  encode,
  toObject,
  toReference,
};
