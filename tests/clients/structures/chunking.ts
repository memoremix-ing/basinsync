/** Deterministic content-defined byte chunking, independent of storage and keys. */
import { check } from "./core";
export type ChunkPolicy = { min: number; target: number; max: number; boundary: "low" | "mixed"; runAnchors: boolean };
const GEAR = (() => { let n = 0x9e3779b9; return Uint32Array.from({ length: 256 }, () => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return n >>> 0; }); })();
function policy(options: Partial<ChunkPolicy> = {}): ChunkPolicy {
  const p = { min: 16384, target: 65536, max: 262144, runAnchors: true, boundary: "mixed" as const, ...options };
  check(p.boundary === "low" || p.boundary === "mixed", "invalid boundary hash policy");
  check(typeof p.runAnchors === "boolean", "invalid run-anchor policy");
  check(Number.isInteger(p.min) && p.min >= 1 && Number.isInteger(p.target) && p.min <= p.target && p.target <= p.max && p.target <= 2 ** 24 && (p.target & (p.target - 1)) === 0, "invalid byte chunk target");
  check(Number.isInteger(p.max) && p.max <= 32 * 1024 * 1024, "invalid file chunk bounds");
  return p;
}
class ByteChunker {
  private data: Uint8Array;
  used = 0;
  private hash = 0;
  private last = -1;
  private run = 0;
  constructor(readonly p: ChunkPolicy) { this.data = new Uint8Array(p.max); }
  take() {
    const bytes = this.data.slice(0, this.used);
    this.used = 0; this.hash = 0; this.last = -1; this.run = 0;
    return bytes;
  }
  closesBefore(byte: number) { return this.p.runAnchors && this.run >= 64 && byte !== this.last && this.used >= this.p.min; }
  *add(bytes: Uint8Array): Generator<Uint8Array> {
    const p = this.p;
    for (const byte of bytes) {
      if (this.closesBefore(byte)) yield this.take();
      this.run = byte === this.last ? this.run + 1 : 1; this.last = byte;
      this.data[this.used++] = byte; this.hash = ((this.hash << 1) + GEAR[byte]) >>> 0;
      let boundary = this.hash;
      if (p.boundary === "mixed") {
        boundary ^= boundary >>> 16; boundary = Math.imul(boundary, 0x7feb352d);
        boundary ^= boundary >>> 15; boundary = Math.imul(boundary, 0x846ca68b); boundary ^= boundary >>> 16;
      }
      if (this.used >= p.max || (this.used >= p.min && (boundary & (p.target - 1)) === 0)) yield this.take();
    }
  }
}
export function* chunkBytes(input: Iterable<Uint8Array>, options: Partial<ChunkPolicy> = {}): Generator<Uint8Array> {
  const chunker = new ByteChunker(policy(options));
  for (const bytes of input) yield* chunker.add(bytes);
  if (chunker.used) yield chunker.take();
}
