/** SL2(F_(2^127-1)), generators A(2)/B(2), bytes most-significant bit first.
 * Compatible with zed-industries/bromberg_sl2. A composable consumer checksum;
 * basin edges still use SHA-384 for their serialized objects.
 */
import { check } from "./core";
const P = (1n << 127n) - 1n;
export type Matrix = [bigint, bigint, bigint, bigint];
export const identity = (): Matrix => [1n, 0n, 0n, 1n];
export function multiply(x: Matrix, y: Matrix): Matrix {
  return [
    (x[0] * y[0] + x[1] * y[2]) % P,
    (x[0] * y[1] + x[1] * y[3]) % P,
    (x[2] * y[0] + x[3] * y[2]) % P,
    (x[2] * y[1] + x[3] * y[3]) % P,
  ];
}
export function matrix(bytes: Uint8Array): Matrix {
  check(bytes.length === 64, "invalid SL2 length");
  const n = (offset: number) => {
    let n = 0n;
    for (const b of bytes.subarray(offset, offset + 16))
      n = (n << 8n) | BigInt(b);
    check(n < P, "noncanonical SL2 field");
    return n;
  };
  const m: Matrix = [n(0), n(16), n(32), n(48)];
  check(
    (m[0] * m[3] - m[1] * m[2] + P * P) % P === 1n,
    "invalid SL2 determinant",
  );
  return m;
}
export function bytes(m: Matrix): Uint8Array {
  const out = new Uint8Array(64);
  for (let j = 0; j < 4; j++) {
    let n = m[j];
    for (let i = 15; i >= 0; i--) {
      out[j * 16 + i] = Number(n & 255n);
      n >>= 8n;
    }
  }
  return out;
}
export function hash(input: Uint8Array): Uint8Array {
  let [a, b, c, d] = identity();
  for (const byte of input)
    for (let bit = 7; bit >= 0; bit--) {
      if ((byte >> bit) & 1) {
        b = (2n * a + b) % P;
        d = (2n * c + d) % P;
      } else {
        a = (a + 2n * b) % P;
        c = (c + 2n * d) % P;
      }
    }
  return bytes([a, b, c, d]);
}
export const combine = (digests: readonly Uint8Array[]) =>
  bytes(digests.map(matrix).reduce(multiply, identity()));
