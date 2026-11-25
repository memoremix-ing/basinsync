/** Content-only, byte-chunked prolly files. Storage identity is separate from content identity. */
import { Basin, type Edge, check, concat, utf8, hex, sha384, edgeFrom, validateNode } from "./core";
import { built } from "./packed";
import { Reference } from "../flexbuffer";
import * as crc from "./crc64nvme";
export const PROLLY_TREELIST = ".prolly-treelist/";
import type { ProllyTreelistPolicy_S0, ProllyTreelistSummary_S0 } from "./types";
export type TreelistPolicy = ProllyTreelistPolicy_S0;
export type TreelistSummary = ProllyTreelistSummary_S0;
type Header = { depth: number; closed: boolean; policy: TreelistPolicy };
type D = { edge: Edge; h: Header; s: TreelistSummary };
import { diffBytes, type ByteSequence, type SequenceNode } from "./byte-diff";
export type { ByteEdit as FileEdit } from "./byte-diff";
const GEAR = (() => { let n = 0x9e3779b9; return Uint32Array.from({ length: 256 }, () => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return n >>> 0; }); })();
function policy(options: Partial<TreelistPolicy> = {}): TreelistPolicy {
  const p = { min: 16384, target: 65536, max: 262144, branchTarget: 32, branchMax: 128, runAnchors: true, boundary: "mixed" as const, ...options };
  check(p.boundary === "low" || p.boundary === "mixed", "invalid boundary hash policy");
  check(typeof p.runAnchors === "boolean", "invalid run-anchor policy");
  check(Number.isInteger(p.min) && p.min >= 1 && Number.isInteger(p.target) && p.min <= p.target && p.target <= p.max && p.target <= 2 ** 24 && (p.target & (p.target - 1)) === 0, "invalid byte chunk target");
  check(Number.isInteger(p.max) && p.max <= 32 * 1024 * 1024 && Number.isInteger(p.branchMax) && p.branchMax <= 255 && p.branchMax >= p.branchTarget && Number.isInteger(p.branchTarget) && p.branchTarget >= 2 && (p.branchTarget & (p.branchTarget - 1)) === 0, "invalid file chunk bounds");
  return p;
}
function descriptor(edge: Edge): D {
  check(edge[1] === "sync.memoremix.com" && edge[2] === PROLLY_TREELIST && edge[6][0] === 0, "unsupported prolly file");
  const h = edge[5] as Header, s = edge[6][1] as TreelistSummary;
  policy(h.policy);
  check(Number.isInteger(h.depth) && h.depth >= 0 && h.depth < 128 && typeof h.closed === "boolean", "invalid file depth");
  check(typeof s.size === "bigint" && s.size >= 0n && s.crc64nvme instanceof Uint8Array && s.crc64nvme.length === 8 && s.content instanceof Uint8Array && s.content.length === 48, "invalid file summary");
  check(s.uniform === null || (Number.isInteger(s.uniform) && s.uniform >= 0 && s.uniform <= 255), "invalid uniform byte summary");
  return { edge, h, s };
}
const signature = (children: D[]) => children.map(d => `${hex(d.edge[6].sha384)}/${d.edge[6].revision}`).join("|");
class Builder {
  constructor(readonly basin: Basin, readonly p: TreelistPolicy, readonly old = new Map<string, D>()) {}
  async leaf(bytes: Uint8Array, closed: boolean): Promise<D> {
    const s: TreelistSummary = { size: BigInt(bytes.length), crc64nvme: crc.hash(bytes), uniform: bytes.length && bytes.every(b => b === bytes[0]) ? bytes[0] : null, content: await sha384(concat([utf8("basinsync/prolly-treelist/0/leaf/"), bytes])) };
    return this.seal(0, closed, s, bytes, null);
  }
  async seal(depth: number, closed: boolean, s: TreelistSummary, data: Uint8Array | null, children: D[] | null): Promise<D> {
    if (children) { const old = this.old.get(signature(children)); if (old && old.h.closed === closed) return old; }
    const edges = children?.map(c => c.edge) ?? [], node = built(this.basin, PROLLY_TREELIST, { depth, closed, policy: this.p }, [0, s, data, children ? edges : null], edges);
    return descriptor(await this.basin.seal(node.node, edges));
  }
  async root(leaves: D[]): Promise<D> {
    if (!leaves.length) return this.leaf(new Uint8Array(), false);
    for (let depth = 1; leaves.length > 1; depth++) {
      check(depth < 128, "file height limit");
      const next: D[] = []; let group: D[] = [];
      const emit = async (closed: boolean) => {
        let size = 0n; let checksum: Uint8Array = new Uint8Array(8);
        for (const d of group) { size += d.s.size; checksum = crc.combine(checksum, d.s.crc64nvme, d.s.size); }
        const content = await sha384(concat([utf8("basinsync/prolly-treelist/0/branch/"), ...group.flatMap(d => [d.s.content, utf8(`${d.s.size};`)])]));
        next.push(await this.seal(depth, closed, { size, crc64nvme: checksum, content, uniform: group.every(d => d.s.uniform === group[0].s.uniform) ? group[0].s.uniform : null }, null, group)); group = [];
      };
      for (const d of leaves) {
        group.push(d);
        const hash = new DataView(d.s.content.buffer, d.s.content.byteOffset, 4).getUint32(0, true);
        if (group.length >= this.p.branchMax || (group.length >= 2 && (hash & (this.p.branchTarget - 1)) === 0)) await emit(true);
      }
      if (group.length) await emit(false);
      leaves = next;
    }
    return leaves[0];
  }
}
/** Content chunking is shared with the trie control to isolate routing effects. */
class ByteChunker {
  private data: Uint8Array;
  used = 0;
  private hash = 0;
  private last = -1;
  private run = 0;
  constructor(readonly p: TreelistPolicy) { this.data = new Uint8Array(p.max); }
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
export function* chunkBytes(input: Iterable<Uint8Array>, options: Partial<TreelistPolicy> = {}): Generator<Uint8Array> {
  const chunker = new ByteChunker(policy(options));
  for (const bytes of input) yield* chunker.add(bytes);
  if (chunker.used) yield chunker.take();
}
class Chunker {
  readonly bytes: ByteChunker;
  constructor(readonly builder: Builder, readonly output: D[]) { this.bytes = new ByteChunker(builder.p); }
  get used() { return this.bytes.used; }
  async emit(closed: boolean) { if (this.used) this.output.push(await this.builder.leaf(this.bytes.take(), closed)); }
  async add(bytes: Uint8Array) { for (const chunk of this.bytes.add(bytes)) this.output.push(await this.builder.leaf(chunk, true)); }
}

export class ProllyTreelist {
  private readonly d: D;
  private readonly verified = new WeakSet<Reference>();
  constructor(readonly basin: Basin, readonly root: Edge) { this.d = descriptor(root); }
  get summary() { return this.d.s; }
  static async build(basin: Basin, chunks: Iterable<Uint8Array>, options: Partial<TreelistPolicy> = {}) {
    const builder = new Builder(basin, policy(options)), leaves: D[] = [], chunker = new Chunker(builder, leaves);
    for (const bytes of chunks) await chunker.add(new Uint8Array(bytes));
    await chunker.emit(false);
    return new ProllyTreelist(basin, (await builder.root(leaves)).edge);
  }
  private async load(d: D) {
    const r = this.basin.peek(d.edge) ?? await this.basin.load(d.edge); validateNode(r, PROLLY_TREELIST);
    const f = r.get("6"); check(f.length() === 4 && f.get(0).intValue() === 0 && (d.h.depth ? f.get(2).isNull() : f.get(3).isNull()), "invalid file node");
    if (!this.verified.has(r)) {
      const message = d.h.depth
        ? concat([utf8("basinsync/prolly-treelist/0/branch/"), ...this.children(r, d).flatMap(c => [c.s.content, utf8(`${c.s.size};`)])])
        : concat([utf8("basinsync/prolly-treelist/0/leaf/"), this.bytes(r, d)]);
      const uniform = d.h.depth
        ? (() => { const c = this.children(r, d); return c.every(x => x.s.uniform === c[0].s.uniform) ? c[0].s.uniform : null; })()
        : (() => { const b = this.bytes(r, d); return b.length && b.every(x => x === b[0]) ? b[0] : null; })();
      check(uniform === d.s.uniform, "file uniform summary mismatch");
      check(hex(await sha384(message)) === hex(d.s.content), "file content hash mismatch");
      this.verified.add(r);
    }
    return r;
  }
  private children(r: Reference, d: D): D[] {
    const v = r.get("6").get(3), out: D[] = [];
    check(v.isVector() && v.length() >= 1 && v.length() <= d.h.policy.branchMax, "invalid file children");
    for (let i = 0; i < v.length(); i++) {
      const c = descriptor(edgeFrom(v.get(i)));
      check(c.h.depth === d.h.depth - 1 && (Object.keys(d.h.policy) as (keyof TreelistPolicy)[]).every(k => c.h.policy[k] === d.h.policy[k]), "invalid child depth/policy");
      out.push(c);
    }
    check(out.reduce((n, c) => n + c.s.size, 0n) === d.s.size, "invalid file byte size");
    return out;
  }
  private bytes(r: Reference, d: D) {
    const b = r.get("6").get(2).blobValue(); check(b && BigInt(b.length) === d.s.size && b.length <= d.h.policy.max, "invalid file chunk"); return b;
  }
  async read(start: bigint, length: number): Promise<Uint8Array> {
    check(start >= 0n && Number.isSafeInteger(length) && length >= 0 && length <= (this.basin.options.maxBytes ?? 64 * 1024 * 1024), "invalid file range");
    const end = start + BigInt(length) < this.d.s.size ? start + BigInt(length) : this.d.s.size;
    if (start >= end) return new Uint8Array();
    const out = new Uint8Array(Number(end - start));
    const walk = async (d: D, at: bigint): Promise<void> => {
      if (at >= end || at + d.s.size <= start) return;
      const r = await this.load(d);
      if (d.h.depth) for (const c of this.children(r, d)) { await walk(c, at); at += c.s.size; }
      else { const b = this.bytes(r, d), a = start > at ? start : at, z = end < at + d.s.size ? end : at + d.s.size; out.set(b.subarray(Number(a - at), Number(z - at)), Number(a - start)); }
    };
    await walk(this.d, 0n);
    if (start === 0n && end === this.d.s.size) check(hex(crc.hash(out)) === hex(this.d.s.crc64nvme), "file checksum mismatch");
    return out;
  }
  async splice(start: bigint, remove: bigint, insert: Uint8Array) {
    check(start >= 0n && remove >= 0n && start + remove <= this.d.s.size, "invalid file splice");
    if (!remove && !insert.length) return this;
    const owned = new Uint8Array(insert), leaves: D[] = [], old = new Map<string, D>();
    const collect = async (d: D): Promise<void> => {
      if (!d.h.depth) { leaves.push(d); return; }
      const children = this.children(await this.load(d), d); old.set(signature(children), d);
      for (const c of children) await collect(c);
    };
    await collect(this.d);
    const builder = new Builder(this.basin, this.d.h.policy, old), output: D[] = [], chunker = new Chunker(builder, output);
    let at = 0n, inserted = false;
    for (let i = 0; i < leaves.length; i++) {
      const d = leaves[i], end = at + d.s.size;
      // Run boundaries are triggered by the next byte. A uniform successor
      // authenticates that lookahead without downloading its object.
      if (inserted && at >= start + remove && chunker.used && d.s.uniform !== null && chunker.bytes.closesBefore(d.s.uniform)) await chunker.emit(true);
      if (!chunker.used && (((end < start || (end === start && !this.d.h.policy.runAnchors)) && !(i === leaves.length - 1 && !d.h.closed)) || (inserted && at >= start + remove))) { output.push(d); at = end; continue; }
      if (inserted && at >= start && end <= start + remove) { at = end; continue; }
      const bytes = this.bytes(await this.load(d), d);
      if (at < start) await chunker.add(bytes.subarray(0, Number((start < end ? start : end) - at)));
      if (!inserted && start <= end) { await chunker.add(owned); inserted = true; }
      if (end > start + remove) await chunker.add(bytes.subarray(Number((start + remove > at ? start + remove : at) - at)));
      at = end;
    }
    if (!inserted) await chunker.add(owned);
    await chunker.emit(false);
    return new ProllyTreelist(this.basin, (await builder.root(output)).edge);
  }
  sequence(uniform = true): ByteSequence {
    const node = (d: D): SequenceNode => ({
      uniform: uniform ? d.s.uniform ?? undefined : undefined, size: d.s.size, identity: `content/${hex(d.s.content)}`, rank: d.h.depth,
      expand: async () => this.children(await this.load(d), d).map(node),
    });
    return { root: node(this.d), read: (at, n) => this.read(at, n) };
  }
  insert(at: bigint, bytes: Uint8Array) { return this.splice(at, 0n, bytes); }
  remove(at: bigint, length: bigint) { return this.splice(at, length, new Uint8Array()); }
  diff(next: ProllyTreelist, refineBytes = 65536) { return diffBytes(this.sequence(), next.sequence(), refineBytes); }
}
