/** Experimental key-anchored prolly page sequence. Byte offsets are relative summaries. */
import { Reference } from "../flexbuffer";
import { Basin, type Edge, key, hex, compare, check, edgeFrom,
  validateNode, sha384, utf8, concat, capability, link } from "./core";
import { built } from "./packed";
import * as crc from "./crc64nvme";
export const PROLLY = ".prolly-pages/";
import type { ProllyPages_S0, ProllyPolicy_S0, ProllySummary_S0 } from "./types";
export type PageSummary = ProllySummary_S0;
export type ProllyPolicy = ProllyPolicy_S0;
export type ProllyHeader = ProllyPages_S0[5];
type Page = [Uint8Array, Uint8Array];
type Descriptor = { edge: Edge; header: ProllyHeader; summary: PageSummary };
const empty = (): PageSummary => ({ size: 0n, count: 0n, crc64nvme: new Uint8Array(8) });
const sum = (parts: PageSummary[]) => parts.reduce((a, b) => ({ size: a.size + b.size,
  count: a.count + b.count, crc64nvme: crc.combine(a.crc64nvme, b.crc64nvme, b.size) }), empty());
function policy(options: Partial<ProllyPolicy> = {}): ProllyPolicy {
  const p = { target: 16, min: 4, max: 64, maxBytes: 1024 * 1024, branchTarget: 32, branchMax: 128, ...options };
  check([p.target, p.branchTarget].every(n => Number.isInteger(n) && n >= 2 && n <= 128 && (n & (n - 1)) === 0), "invalid boundary target");
  check(Number.isInteger(p.max) && Number.isInteger(p.min) && p.min >= 1 && p.min <= p.target && p.target <= p.max && p.max <= 255, "invalid leaf bounds");
  check(Number.isInteger(p.branchMax) && p.branchMax >= p.branchTarget && p.branchMax <= 255, "invalid routing bounds");
  check(Number.isSafeInteger(p.maxBytes) && p.maxBytes >= 1 && p.maxBytes <= 32 * 1024 * 1024, "invalid leaf byte budget");
  return p;
}
function describe(edge: Edge): Descriptor {
  check(edge[1] === "sync.memoremix.com" && edge[2] === PROLLY && edge[6][0] === 0, "wrong prolly species/migration");
  const header = edge[5] as ProllyHeader, summary = edge[6][1] as PageSummary;
  policy(header.policy);
  check(Number.isInteger(header.depth) && header.depth >= 0 && header.depth < 128 && typeof header.closed === "boolean", "invalid prolly depth");
  check(typeof summary.size === "bigint" && summary.size >= 0n && typeof summary.count === "bigint" && summary.count >= 0n && summary.crc64nvme instanceof Uint8Array && summary.crc64nvme.length === 8, "invalid prolly summary");
  check(header.keys === null ? summary.count === 0n : Array.isArray(header.keys) && header.keys.length === 2 && header.keys.every(k => k instanceof Uint8Array) && compare(header.keys[0], header.keys[1]) <= 0, "invalid prolly key bounds");
  return { edge, header, summary };
}
const identity = (e: Edge) => `${capability(link(e))}/${hex(e[6].sha384)}`;
const signature = (depth: number, children: Descriptor[]) => `${depth}:${children.map(c => identity(c.edge)).join("|")}`;
class Builder {
  private hashes = new Map<string, number>();
  constructor(readonly basin: Basin, readonly p: ProllyPolicy, readonly old = new Map<string, Descriptor>()) {}
  async cut(key: Uint8Array, depth: number, target: number) {
    const id = `${depth}:${hex(key)}`;
    let n = this.hashes.get(id);
    if (n === undefined) {
      const bytes = await sha384(concat([utf8(`basinsync/prolly-pages/0/${depth}/`), key]));
      n = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
      this.hashes.set(id, n);
    }
    return (n & (target - 1)) === 0;
  }
  async seal(depth: number, keys: ProllyHeader["keys"], closed: boolean, summary: PageSummary, rows: Page[] | null, children: Descriptor[] | null): Promise<Descriptor> {
    if (children) {
      const old = this.old.get(signature(depth, children));
      if (old && old.header.closed === closed) return old;
    }
    const header: ProllyHeader = { depth, keys, closed, policy: this.p };
    const body = rows ? { keys: rows.map(r => r[0]), pages: rows.map(r => r[1]) } : null;
    const edges = children?.map(c => c.edge) ?? [];
    const node = built(this.basin, PROLLY, header, [0, summary, body, children ? edges : null], edges);
    return describe(await this.basin.seal(node.node, edges));
  }
  async leaf(rows: Page[], closed: boolean): Promise<Descriptor> {
    return this.seal(0, rows.length ? [rows[0][0], rows.at(-1)![0]] : null, closed,
      sum(rows.map(r => ({ size: BigInt(r[1].length), count: 1n, crc64nvme: crc.hash(r[1]) }))), rows, null);
  }
  async root(leaves: Descriptor[]): Promise<Descriptor> {
    if (!leaves.length) return this.leaf([], false);
    for (let depth = 1; leaves.length > 1; depth++) {
      check(depth < 128, "prolly height limit");
      const next: Descriptor[] = [];
      let group: Descriptor[] = [];
      const emit = async (closed: boolean) => {
        const first = group[0].header.keys!, last = group.at(-1)!.header.keys!;
        next.push(await this.seal(depth, [first[0], last[1]], closed, sum(group.map(c => c.summary)), null, group));
        group = [];
      };
      for (const child of leaves) {
        group.push(child);
        if (group.length >= this.p.branchMax || (group.length >= 2 && await this.cut(child.header.keys![1], depth, this.p.branchTarget))) await emit(true);
      }
      if (group.length) await emit(false);
      leaves = next;
    }
    return leaves[0];
  }
}
class Chunker {
  rows: Page[] = [];
  bytes = 0;
  constructor(readonly builder: Builder, readonly output: Descriptor[]) {}
  async emit(closed: boolean) {
    if (this.rows.length) this.output.push(await this.builder.leaf(this.rows, closed));
    this.rows = []; this.bytes = 0;
  }
  async add(row: Page) {
    const p = this.builder.p;
    check(row[1].length <= p.maxBytes, "page exceeds leaf byte budget");
    if (this.rows.length && this.bytes + row[1].length > p.maxBytes) await this.emit(true);
    this.rows.push(row); this.bytes += row[1].length;
    if (this.rows.length >= p.max || this.bytes >= p.maxBytes || (this.rows.length >= p.min && await this.builder.cut(row[0], 0, p.target))) await this.emit(true);
  }
}
export class ProllyPages {
  readonly descriptor: Descriptor;
  constructor(readonly basin: Basin, readonly root: Edge) { this.descriptor = describe(root); }
  get summary() { return this.descriptor.summary; }
  static async build(basin: Basin, pages: Iterable<[Uint8Array | string, Uint8Array]>, options: Partial<ProllyPolicy> = {}) {
    const p = policy(options), rows = [...pages].map(([k, b]) => [key(k), new Uint8Array(b)] as Page).sort((a, b) => compare(a[0], b[0]));
    check(rows.every((r, i) => !i || compare(rows[i - 1][0], r[0]) < 0), "duplicate page key");
    const builder = new Builder(basin, p), leaves: Descriptor[] = [], chunker = new Chunker(builder, leaves);
    for (const row of rows) await chunker.add(row);
    await chunker.emit(false);
    return new ProllyPages(basin, (await builder.root(leaves)).edge);
  }
  private async load(d: Descriptor) {
    const r = this.basin.peek(d.edge) ?? await this.basin.load(d.edge);
    validateNode(r, PROLLY);
    const footer = r.get("6");
    check(footer.length() === 4 && footer.get(0).intValue() === 0, "unsupported prolly migration");
    check(d.header.depth ? footer.get(2).isNull() : footer.get(3).isNull(), "mixed prolly node kinds");
    return r;
  }
  private children(r: Reference, d: Descriptor): Descriptor[] {
    const vector = r.get("6").get(3), children: Descriptor[] = [];
    check(vector.isVector() && vector.length() >= 1 && vector.length() <= d.header.policy.branchMax, "invalid prolly children");
    for (let i = 0; i < vector.length(); i++) {
      const c = describe(edgeFrom(vector.get(i)));
      check(c.header.depth === d.header.depth - 1 && (Object.keys(d.header.policy) as (keyof ProllyPolicy)[]).every(k => c.header.policy[k] === d.header.policy[k]), "invalid prolly child policy/depth");
      check(c.header.keys !== null && (!i || compare(children[i - 1].header.keys![1], c.header.keys[0]) < 0), "overlapping prolly children");
      children.push(c);
    }
    // Object SHA-384 authenticates these stored summaries. Do not recombine
    // every child CRC on the range/point hot path; publication and full-read
    // tests check the consumer checksum independently.
    check(children.reduce((n, c) => n + c.summary.size, 0n) === d.summary.size && children.reduce((n, c) => n + c.summary.count, 0n) === d.summary.count, "invalid routing size/count");
    return children;
  }
  private rows(r: Reference, d: Descriptor): Page[] {
    const body = r.get("6").get(2), keys = body.get("keys"), pages = body.get("pages"), rows: Page[] = [];
    check(body.isMap() && keys.isVector() && pages.isVector() && keys.length() === pages.length(), "invalid prolly leaf");
    for (let i = 0; i < keys.length(); i++) {
      const k = keys.get(i).blobValue(), b = pages.get(i).blobValue();
      check(k && b && (!i || compare(rows[i - 1][0], k) < 0), "invalid prolly row");
      rows.push([k, b]); // borrowed immutable bytes; public APIs copy on return.
    }
    check(BigInt(rows.length) === d.summary.count && rows.reduce((n, r) => n + BigInt(r[1].length), 0n) === d.summary.size, "invalid leaf size/count");
    check(rows.length <= d.header.policy.max && rows.every(r => r[1].length <= d.header.policy.maxBytes), "invalid leaf budget");
    check(rows.length ? d.header.keys !== null && compare(rows[0][0], d.header.keys[0]) === 0 && compare(rows.at(-1)![0], d.header.keys[1]) === 0 : d.header.keys === null, "invalid leaf bounds");
    return rows;
  }
  async get(k: Uint8Array | string): Promise<Uint8Array | undefined> {
    const wanted = key(k); let d = this.descriptor;
    while (d.header.keys && compare(wanted, d.header.keys[0]) >= 0 && compare(wanted, d.header.keys[1]) <= 0) {
      const r = await this.load(d);
      if (d.header.depth === 0) {
        const row = this.rows(r, d).find(([k]) => compare(k, wanted) === 0);
        return row && new Uint8Array(row[1]);
      }
      const child = this.children(r, d).find(c => compare(wanted, c.header.keys![1]) <= 0);
      if (!child) return;
      d = child;
    }
  }
  async read(start: bigint, length: number): Promise<Uint8Array> {
    check(start >= 0n && Number.isSafeInteger(length) && length >= 0 && length <= (this.basin.options.maxBytes ?? 64 * 1024 * 1024), "invalid byte range");
    if (start >= this.summary.size || length === 0) return new Uint8Array();
    const end = start + BigInt(length) < this.summary.size ? start + BigInt(length) : this.summary.size;
    const output = new Uint8Array(Number(end - start));
    const walk = async (d: Descriptor, at: bigint): Promise<void> => {
      if (at >= end || at + d.summary.size <= start) return;
      const r = await this.load(d);
      if (d.header.depth) {
        for (const c of this.children(r, d)) { await walk(c, at); at += c.summary.size; }
      } else for (const [, bytes] of this.rows(r, d)) {
        const a = start > at ? start : at, z = end < at + BigInt(bytes.length) ? end : at + BigInt(bytes.length);
        if (a < z) output.set(bytes.subarray(Number(a - at), Number(z - at)), Number(a - start));
        at += BigInt(bytes.length);
      }
    };
    await walk(this.descriptor, 0n);
    if (start === 0n && end === this.summary.size) check(hex(crc.hash(output)) === hex(this.summary.crc64nvme), "full page checksum mismatch");
    return output;
  }
  /** Rechunk only edited leaf runs until a prior boundary is reached again.
   * Routing descriptors are scanned, but unchanged page bodies stay opaque. */
  async update(changes: Iterable<[Uint8Array | string, Uint8Array | null]>) {
    const byKey = new Map<string, [Uint8Array, Uint8Array | null]>();
    for (const [k, v] of changes) { const owned = key(k); byKey.set(hex(owned), [owned, v === null ? null : new Uint8Array(v)]); }
    const edits = [...byKey.values()].sort((a, b) => compare(a[0], b[0]));
    if (!edits.length) return this;
    const leaves: Descriptor[] = [], old = new Map<string, Descriptor>();
    const collect = async (d: Descriptor): Promise<void> => {
      if (!d.header.depth) { leaves.push(d); return; }
      const children = this.children(await this.load(d), d);
      old.set(signature(d.header.depth, children), d);
      for (const c of children) await collect(c);
    };
    await collect(this.descriptor);
    const builder = new Builder(this.basin, this.descriptor.header.policy, old), next: Descriptor[] = [], chunker = new Chunker(builder, next);
    let edit = 0;
    for (let i = 0; i < leaves.length; i++) {
      const d = leaves[i], last = d.header.keys?.[1];
      const touched = !last || (edit < edits.length && compare(edits[edit][0], last) <= 0);
      // A byte-cap boundary depends on the first row of the next leaf. Start
      // one leaf earlier so changing/removing that row can undo the boundary.
      const nextEnd = leaves[i + 1]?.header.keys?.[1];
      const precedesEdit = edit < edits.length && nextEnd && compare(edits[edit][0], nextEnd) <= 0;
      if (!touched && !precedesEdit && !chunker.rows.length && !(i === leaves.length - 1 && edit < edits.length)) { next.push(d); continue; }
      for (const row of this.rows(await this.load(d), d)) {
        let replaced = false;
        while (edit < edits.length && compare(edits[edit][0], row[0]) <= 0) {
          const [k, v] = edits[edit++];
          if (compare(k, row[0]) === 0) replaced = true;
          if (v !== null) await chunker.add([k, v]);
        }
        if (!replaced) await chunker.add(row);
      }
    }
    for (; edit < edits.length; edit++) if (edits[edit][1] !== null) await chunker.add(edits[edit] as Page);
    await chunker.emit(false);
    return new ProllyPages(this.basin, (await builder.root(next)).edge);
  }
}
