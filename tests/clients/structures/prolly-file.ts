/** Content-only, byte-chunked prolly files. Storage identity is separate from content identity. */
import { Basin, type Edge, check, concat, utf8, hex, sha384, edgeFrom, validateNode } from "./core";
import { built } from "./packed";
import { Reference } from "../flexbuffer";
import * as crc from "./crc64nvme";
export const PROLLY_FILE = ".prolly-file/";
import type { ProllyFilePolicy_S0, ProllyFileSummary_S0 } from "./types";
export type FilePolicy = ProllyFilePolicy_S0;
export type FileSummary = ProllyFileSummary_S0;
type Header = { depth: number; closed: boolean; policy: FilePolicy };
type D = { edge: Edge; h: Header; s: FileSummary };
type Span = { d: D; at: bigint };
export type FileEdit = { before: { start: bigint; length: bigint }; after: { start: bigint; length: bigint } };
const GEAR = (() => { let n = 0x9e3779b9; return Uint32Array.from({ length: 256 }, () => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return n >>> 0; }); })();
function policy(options: Partial<FilePolicy> = {}): FilePolicy {
  const p = { min: 16384, target: 65536, max: 262144, branchTarget: 32, branchMax: 128, runAnchors: true, ...options };
  check(typeof p.runAnchors === "boolean", "invalid run-anchor policy");
  check(Number.isInteger(p.min) && p.min >= 1 && Number.isInteger(p.target) && p.min <= p.target && p.target <= p.max && p.target <= 2 ** 24 && (p.target & (p.target - 1)) === 0, "invalid byte chunk target");
  check(Number.isInteger(p.max) && p.max <= 32 * 1024 * 1024 && Number.isInteger(p.branchMax) && p.branchMax <= 255 && p.branchMax >= p.branchTarget && Number.isInteger(p.branchTarget) && p.branchTarget >= 2 && (p.branchTarget & (p.branchTarget - 1)) === 0, "invalid file chunk bounds");
  return p;
}
function descriptor(edge: Edge): D {
  check(edge[1] === "sync.memoremix.com" && edge[2] === PROLLY_FILE && edge[6][0] === 0, "unsupported prolly file");
  const h = edge[5] as Header, s = edge[6][1] as FileSummary;
  policy(h.policy);
  check(Number.isInteger(h.depth) && h.depth >= 0 && h.depth < 128 && typeof h.closed === "boolean", "invalid file depth");
  check(typeof s.size === "bigint" && s.size >= 0n && s.crc64nvme instanceof Uint8Array && s.crc64nvme.length === 8 && s.content instanceof Uint8Array && s.content.length === 48, "invalid file summary");
  return { edge, h, s };
}
const same = (a: D, b: D) => a.s.size === b.s.size && hex(a.s.content) === hex(b.s.content);
const id = (d: D) => `${d.s.size}:${hex(d.s.content)}`;
const signature = (children: D[]) => children.map(d => `${hex(d.edge[6].sha384)}/${d.edge[6].revision}`).join("|");
class Builder {
  constructor(readonly basin: Basin, readonly p: FilePolicy, readonly old = new Map<string, D>()) {}
  async leaf(bytes: Uint8Array, closed: boolean): Promise<D> {
    const s: FileSummary = { size: BigInt(bytes.length), crc64nvme: crc.hash(bytes), content: await sha384(concat([utf8("basinsync/prolly-file/0/leaf/"), bytes])) };
    return this.seal(0, closed, s, bytes, null);
  }
  async seal(depth: number, closed: boolean, s: FileSummary, data: Uint8Array | null, children: D[] | null): Promise<D> {
    if (children) { const old = this.old.get(signature(children)); if (old && old.h.closed === closed) return old; }
    const edges = children?.map(c => c.edge) ?? [], node = built(this.basin, PROLLY_FILE, { depth, closed, policy: this.p }, [0, s, data, children ? edges : null], edges);
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
        const content = await sha384(concat([utf8("basinsync/prolly-file/0/branch/"), ...group.flatMap(d => [d.s.content, utf8(`${d.s.size};`)])]));
        next.push(await this.seal(depth, closed, { size, crc64nvme: checksum, content }, null, group)); group = [];
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
class Chunker {
  private data: Uint8Array;
  used = 0;
  private hash = 0;
  private last = -1;
  private run = 0;
  constructor(readonly builder: Builder, readonly output: D[]) { this.data = new Uint8Array(builder.p.max); }
  async emit(closed: boolean) {
    if (this.used) this.output.push(await this.builder.leaf(this.data.slice(0, this.used), closed));
    this.used = 0; this.hash = 0; this.last = -1; this.run = 0;
  }
  async add(bytes: Uint8Array) {
    const p = this.builder.p;
    for (const byte of bytes) {
      // Repeated byte runs otherwise contribute little Gear entropy. This
      // content-local anchor makes low-entropy page transitions resynchronizable.
      if (p.runAnchors && this.run >= 64 && byte !== this.last && this.used >= p.min) await this.emit(true);
      this.run = byte === this.last ? this.run + 1 : 1; this.last = byte;
      this.data[this.used++] = byte; this.hash = ((this.hash << 1) + GEAR[byte]) >>> 0;
      if (this.used >= p.max || (this.used >= p.min && (this.hash & (p.target - 1)) === 0)) await this.emit(true);
    }
  }
}
export class ProllyFile {
  private readonly d: D;
  private readonly verified = new WeakSet<Reference>();
  constructor(readonly basin: Basin, readonly root: Edge) { this.d = descriptor(root); }
  get summary() { return this.d.s; }
  static async build(basin: Basin, chunks: Iterable<Uint8Array>, options: Partial<FilePolicy> = {}) {
    const builder = new Builder(basin, policy(options)), leaves: D[] = [], chunker = new Chunker(builder, leaves);
    for (const bytes of chunks) await chunker.add(new Uint8Array(bytes));
    await chunker.emit(false);
    return new ProllyFile(basin, (await builder.root(leaves)).edge);
  }
  private async load(d: D) {
    const r = this.basin.peek(d.edge) ?? await this.basin.load(d.edge); validateNode(r, PROLLY_FILE);
    const f = r.get("6"); check(f.length() === 4 && f.get(0).intValue() === 0 && (d.h.depth ? f.get(2).isNull() : f.get(3).isNull()), "invalid file node");
    if (!this.verified.has(r)) {
      const message = d.h.depth
        ? concat([utf8("basinsync/prolly-file/0/branch/"), ...this.children(r, d).flatMap(c => [c.s.content, utf8(`${c.s.size};`)])])
        : concat([utf8("basinsync/prolly-file/0/leaf/"), this.bytes(r, d)]);
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
      check(c.h.depth === d.h.depth - 1 && (Object.keys(d.h.policy) as (keyof FilePolicy)[]).every(k => c.h.policy[k] === d.h.policy[k]), "invalid child depth/policy");
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
    return new ProllyFile(this.basin, (await builder.root(output)).edge);
  }
  /** Strong content hashes skip unchanged subtrees, including shifted ones.
   * Output spans are ordered byte replacements; windowed refinement trims equal edges. */
  async diff(next: ProllyFile, refineBytes = 65536): Promise<FileEdit[]> {
    check(Number.isSafeInteger(refineBytes) && refineBytes >= 0 && refineBytes <= 32 * 1024 * 1024, "invalid diff refinement window");
    if (same(this.d, next.d)) return [];
    // Different policies/shapes may encode identical bytes. CRC is only a
    // filter: confirm such equality by reading, never treat CRC as proof.
    if (this.d.s.size === next.d.s.size && hex(this.d.s.crc64nvme) === hex(next.d.s.crc64nvme)) {
      let equal = true;
      for (let at = 0n; at < this.d.s.size; at += 1048576n) {
        const a = await this.read(at, 1048576), b = await next.read(at, 1048576);
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) { equal = false; break; }
      }
      if (equal) return [];
    }
    const edits: FileEdit[] = [];
    const total = (a: Span[]) => a.reduce((n, x) => n + x.d.s.size, 0n);
    const expand = async (file: ProllyFile, spans: Span[], depth: number) => {
      const out: Span[] = [];
      for (const span of spans) {
        if (span.d.h.depth !== depth) { out.push(span); continue; }
        let at = span.at;
        for (const d of file.children(await file.load(span.d), span.d)) { out.push({ d, at }); at += d.s.size; }
      }
      return out;
    };
    const emit = (a: Span[], b: Span[], oldAt: bigint, newAt: bigint) => { edits.push({ before: { start: a[0]?.at ?? oldAt, length: total(a) }, after: { start: b[0]?.at ?? newAt, length: total(b) } }); };
    const walk = async (a: Span[], b: Span[], oldAt: bigint, newAt: bigint): Promise<void> => {
      let first = 0, ae = a.length, be = b.length;
      while (first < ae && first < be && same(a[first].d, b[first].d)) { oldAt = a[first].at + a[first].d.s.size; newAt = b[first].at + b[first].d.s.size; first++; }
      while (ae > first && be > first && same(a[ae - 1].d, b[be - 1].d)) { ae--; be--; }
      a = a.slice(first, ae); b = b.slice(first, be);
      if (!a.length && !b.length) return;
      if (!a.length || !b.length) { emit(a, b, oldAt, newAt); return; }
      const anchors = common(a, b);
      if (anchors.length) {
        let ai = 0, bi = 0;
        for (const [i, j] of anchors) {
          await walk(a.slice(ai, i), b.slice(bi, j), oldAt, newAt);
          oldAt = a[i].at + a[i].d.s.size; newAt = b[j].at + b[j].d.s.size; ai = i + 1; bi = j + 1;
        }
        await walk(a.slice(ai), b.slice(bi), oldAt, newAt); return;
      }
      const depth = [...a, ...b].reduce((n, x) => Math.max(n, x.d.h.depth), 0);
      if (!depth) { emit(a, b, oldAt, newAt); return; }
      await walk(await expand(this, a, depth), await expand(next, b, depth), oldAt, newAt);
    };
    await walk([{ d: this.d, at: 0n }], [{ d: next.d, at: 0n }], 0n, 0n);
    const refined: FileEdit[] = [];
    for (const edit of edits) {
      let { start: a, length: al } = edit.before, { start: b, length: bl } = edit.after;
      // Bound working memory, not patch quality: shifted low-entropy content
      // may lack anchors yet still have a long equal suffix. Read windows until
      // a difference, reusing the ordinary immutable node cache.
      if (refineBytes) {
        while (al && bl) {
          const n = Number(al < bl ? al : bl), take = Math.min(refineBytes, n);
          const left = await this.read(a, take), right = await next.read(b, take);
          let prefix = 0; while (prefix < take && left[prefix] === right[prefix]) prefix++;
          a += BigInt(prefix); b += BigInt(prefix); al -= BigInt(prefix); bl -= BigInt(prefix);
          if (prefix < take) break;
        }
        while (al && bl) {
          const take = Math.min(refineBytes, Number(al < bl ? al : bl));
          const left = await this.read(a + al - BigInt(take), take), right = await next.read(b + bl - BigInt(take), take);
          let suffix = 0; while (suffix < take && left[take - 1 - suffix] === right[take - 1 - suffix]) suffix++;
          al -= BigInt(suffix); bl -= BigInt(suffix);
          if (suffix < take) break;
        }
      }
      if (al || bl) refined.push({ before: { start: a, length: al }, after: { start: b, length: bl } });
    }
    return refined;
  }
}
/** Unique content anchors, then LIS to retain order without quadratic LCS. */
function common(a: Span[], b: Span[]): [number, number][] {
  const index = (rows: Span[]) => { const m = new Map<string, number>(); rows.forEach((x, i) => { const k = id(x.d); m.set(k, m.has(k) ? -1 : i); }); return m; };
  const left = index(a), right = index(b), pairs: [number, number][] = [];
  a.forEach((x, i) => { const k = id(x.d), j = right.get(k); if (left.get(k) === i && j !== undefined && j >= 0) pairs.push([i, j]); });
  const tails: number[] = [], previous = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pairs[tails[mid]][1] < pair[1]) lo = mid + 1; else hi = mid; }
    if (lo) previous[i] = tails[lo - 1]; tails[lo] = i;
  });
  const out: [number, number][] = []; let i = tails.at(-1) ?? -1;
  while (i >= 0) { out.push(pairs[i]); i = previous[i]; }
  return out.reverse();
}
