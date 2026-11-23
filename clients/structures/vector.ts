import { VectorMap } from "./logical-vector";
import { type Operation, resolveOperation } from "./operation";
import {
  Basin,
  Edge,
  check,
  DOMAIN,
  edgeFrom,
  object,
  validateNode,
  key,
  u32,
  validateEdge,
  isPromiseLike,
} from "./core";
import { Reference } from "../flexbuffer";
import { type Consumer } from "./trie";
import { pack, built, type Built } from "./packed";
export const VECTOR = ".vector-node/";
export type VectorHeader = import("./types").VectorNode_S0<{
  [index: number]: { Summary: unknown; Value: unknown };
}>[5];
const index = (n: bigint) => {
  check(typeof n === "bigint" && n >= 0n, "invalid vector index");
  return n;
};
const indexBytes = (i: bigint) => {
  let h = i.toString(16);
  return key(h.length % 2 ? `0${h}` : h);
};
function popcount(x: number) {
  x >>>= 0;
  let n = 0;
  while (x) {
    x = (x & (x - 1)) >>> 0;
    n++;
  }
  return n;
}
const has = (bitmap: number, slot: number) => ((bitmap >>> slot) & 1) !== 0;
const rank = (bitmap: number, slot: number) =>
  popcount(bitmap & (2 ** slot - 1));
function checkedHeader(h: VectorHeader): VectorHeader {
  check(
    typeof h.length === "bigint" &&
      typeof h.count === "bigint" &&
      h.length >= 0n &&
      h.count >= 0n &&
      h.count <= h.length,
    "invalid vector counts",
  );
  u32(h.shift);
  u32(h.inlined);
  check(h.shift % 5 === 0 && h.shift < 1280, "invalid vector shift");
  return h;
}
export class Vector<V = unknown, M = null> {
  constructor(
    readonly basin: Basin,
    readonly root: Edge,
    readonly consumer: Consumer<V, M>,
  ) {
    validateEdge(root);
    checkedHeader(root[5] as VectorHeader);
    check(
      root[1] === DOMAIN &&
        root[2] === VECTOR &&
        root[6][0] === consumer.migration,
      "unsupported vector migration",
    );
  }
  get length() {
    return (this.root[5] as VectorHeader).length;
  }
  static async build<V, M>(
    basin: Basin,
    values: Iterable<V>,
    c: Consumer<V, M>,
  ): Promise<Vector<V, M>> {
    const rows: [bigint, V][] = [];
    for (const v of values) rows.push([BigInt(rows.length), v]);
    return Vector.buildEntries(basin, BigInt(rows.length), rows, c);
  }
  static async buildEntries<V, M>(
    basin: Basin,
    length: bigint,
    input: Iterable<[bigint, V]>,
    c: Consumer<V, M>,
  ): Promise<Vector<V, M>> {
    index(length);
    u32(c.migration);
    const rows = [] as { index: bigint; value: V; summary: M }[];
    for (const [i, value] of input) {
      index(i);
      check(i < length, "vector index outside length");
      const summary = c.entry(indexBytes(i), value);
      rows.push({
        index: i,
        value,
        summary: isPromiseLike(summary) ? await summary : summary,
      });
    }
    rows.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
    for (let i = 1; i < rows.length; i++)
      check(rows[i - 1].index !== rows[i].index, "duplicate vector index");
    let shift = 0;
    while (length > 1n << BigInt(shift + 5)) shift += 5;
    check(shift < 1280, "vector nesting limit");
    const build = async (
      part: typeof rows,
      base: bigint,
      span: bigint,
      shift: number,
    ): Promise<Built> => {
      let bitmap = 0;
      const children: Built[] = [],
        values: V[] = [],
        width = 1n << BigInt(shift);
      let position = 0;
      for (let slot = 0; slot < 32; slot++) {
        const lo = base + BigInt(slot) * width,
          end = lo + width,
          begin = position;
        while (position < part.length && part[position].index < end) position++;
        const at = part.slice(begin, position);
        if (!at.length) continue;
        bitmap = (bitmap | (1 << slot)) >>> 0;
        if (shift === 0) values.push(at[0].value);
        else
          children.push(
            await build(
              at,
              lo,
              span - BigInt(slot) * width < width
                ? span - BigInt(slot) * width
                : width,
              shift - 5,
            ),
          );
      }
      const refs =
          shift === 0 && c.edges ? values.flatMap((v) => c.edges!(v)) : [],
        p = await pack(basin, children, values.length, refs);
      const aggregate = part.length
        ? c.combine(part.map((r) => r.summary))
        : c.empty;
      const summary = isPromiseLike(aggregate) ? await aggregate : aggregate;
      return built(
        basin,
        VECTOR,
        { length: span, count: BigInt(part.length), shift, inlined: p.inlined },
        [c.migration, summary, bitmap, shift === 0 ? values : p.slots],
        p.edges,
      );
    };
    const b = await build(rows, 0n, length, shift);
    return new Vector(basin, await basin.seal(b.node, b.edges), c);
  }
  private readonly plans = new WeakMap<
    Reference,
    {
      h: VectorHeader;
      f: Reference;
      bitmap: number;
      slots: Reference;
      children: Map<number, Reference | Edge>;
    }
  >();
  private parts(r: Reference) {
    const cached = this.plans.get(r);
    if (cached) return cached;
    validateNode(r, VECTOR);
    const h = checkedHeader(object<VectorHeader>(r.get("5"))),
      f = r.get("6");
    check(
      f.length() === 4 && f.get(0).intValue() === this.consumer.migration,
      "unsupported vector migration",
    );
    const bitmap = u32(f.get(2).intValue()!),
      slots = f.get(3);
    check(
      slots.isVector() &&
        !slots.isExtension() &&
        slots.length() === popcount(bitmap),
      "invalid vector bitmap",
    );
    const plan = {
      h,
      f,
      bitmap,
      slots,
      children: new Map<number, Reference | Edge>(),
    };
    this.plans.set(r, plan);
    return plan;
  }
  getViewOrDefer(i: bigint): Operation<Reference | undefined> {
    index(i);
    if (i >= this.length || (this.root[5] as VectorHeader).count === 0n) return;
    const digits: number | string =
      i <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(i) : i.toString(32);
    const r = this.basin.peek(this.root);
    return r
      ? this.seek(r, digits, 0)
      : () => this.resume(this.root, digits, 0);
  }
  private *resume(
    edge: Edge,
    i: number | string,
    depth: number,
  ): Generator<PromiseLike<unknown>, Reference | undefined, unknown> {
    const r = (yield this.basin.load(edge)) as Reference;
    const next = this.seek(r, i, depth);
    return typeof next === "function" ? yield* next() : next;
  }
  private seek(
    r: Reference,
    i: number | string,
    depth: number,
  ): Operation<Reference | undefined> {
    for (;;) {
      check(depth++ < 256, "vector nesting limit");
      const p = this.parts(r),
        { h, bitmap, slots } = p;
      const position = h.shift / 5;
      const digit =
        typeof i === "string" ? i.charCodeAt(i.length - 1 - position) : 0;
      const slot =
        typeof i === "number"
          ? Math.floor(i / 2 ** h.shift) % 32
          : Number.isNaN(digit)
            ? 0
            : digit <= 57
              ? digit - 48
              : digit - 87;
      if (!has(bitmap, slot)) return;
      if (h.shift === 0) return slots.get(rank(bitmap, slot));
      let child = p.children.get(slot);
      if (!child) {
        const at = slots.get(rank(bitmap, slot));
        child = at.isMap() ? at : edgeFrom(at);
        p.children.set(slot, child);
      }
      if (Array.isArray(child)) {
        const cached = this.basin.peek(child);
        if (!cached) return () => this.resume(child as Edge, i, depth);
        r = cached;
      } else r = child;
    }
  }
  getOrDefer(i: bigint): Operation<V | undefined> {
    const op = this.getViewOrDefer(i);
    if (typeof op === "function")
      return function* () {
        const r = yield* op();
        return r === undefined ? undefined : object<V>(r);
      };
    return op === undefined ? undefined : object<V>(op);
  }
  async getView(i: bigint): Promise<Reference | undefined> {
    return resolveOperation(this.getViewOrDefer(i));
  }
  async get(i: bigint): Promise<V | undefined> {
    const op = this.getOrDefer(i);
    return typeof op === "function" ? resolveOperation(op) : op;
  }
  async *entries(
    from = 0n,
    to = this.length,
    accept?: (header: VectorHeader, summary: M) => boolean,
  ): AsyncGenerator<[bigint, V]> {
    index(from);
    index(to);
    check(to >= from, "invalid vector range");
    const visit = async function* (
      self: Vector<V, M>,
      r: Reference,
      base: bigint,
      depth: number,
    ): AsyncGenerator<[bigint, V]> {
      check(depth < 256, "vector nesting limit");
      const { h, f, bitmap, slots } = self.parts(r);
      if (
        base >= to ||
        base + h.length <= from ||
        !h.count ||
        (accept && !accept(h, object<M>(f.get(1))))
      )
        return;
      const width = 1n << BigInt(h.shift);
      for (let slot = 0; slot < 32; slot++)
        if (has(bitmap, slot)) {
          const start = base + BigInt(slot) * width;
          if (start >= to || start + width <= from) continue;
          const at = slots.get(rank(bitmap, slot));
          if (h.shift === 0) yield [start, object<V>(at)];
          else if (at.isMap()) yield* visit(self, at, start, depth + 1);
          else {
            const e = edgeFrom(at),
              eh = e[5] as VectorHeader;
            if (!accept || accept(eh, e[6][1] as M))
              yield* visit(self, await self.basin.load(e), start, depth + 1);
          }
        }
    };
    const h = this.root[5] as VectorHeader;
    if (
      from < to &&
      from < this.length &&
      h.count &&
      (!accept || accept(h, this.root[6][1] as M))
    )
      yield* visit(this, await this.basin.load(this.root), 0n, 0);
  }
  /** Load once for synchronous path-copied edits; store explicitly after a batch. */
  async edit(): Promise<VectorEditor<V, M>> {
    const rows: [bigint, V][] = [];
    for await (const row of this.entries()) rows.push(row);
    return VectorEditor.from(this.basin, this.length, rows, this.consumer);
  }
  async update(
    changes: Iterable<[bigint, { set: V } | { delete: true }]>,
    length = this.length,
  ): Promise<Vector<V, M>> {
    index(length);
    const rows = new Map<string, V>();
    for await (const [i, v] of this.entries())
      if (i < length) rows.set(i.toString(), v);
    for (const [i, c] of changes) {
      index(i);
      check(i < length, "vector index outside length");
      if ("delete" in c) rows.delete(i.toString());
      else rows.set(i.toString(), c.set);
    }
    return Vector.buildEntries(
      this.basin,
      length,
      [...rows].map(([i, v]) => [BigInt(i), v]),
      this.consumer,
    );
  }
  async push(value: V) {
    return this.update([[this.length, { set: value }]], this.length + 1n);
  }
  async pop() {
    return this.update([], this.length ? this.length - 1n : 0n);
  }
}

/** Immutable bitmap-vector snapshots. Storage is explicit and canonically repacked. */
export class VectorEditor<V, M = null> {
  private constructor(
    readonly basin: Basin,
    private readonly values: VectorMap<V>,
    readonly consumer: Consumer<V, M>,
  ) {}
  static from<V, M>(
    basin: Basin,
    length: bigint,
    input: Iterable<readonly [bigint, V]>,
    consumer: Consumer<V, M>,
  ): VectorEditor<V, M> {
    return new VectorEditor(basin, VectorMap.from(length, input), consumer);
  }
  get length() {
    return this.values.length;
  }
  get size() {
    return this.values.size;
  }
  get(i: bigint) {
    return this.values.get(i);
  }
  has(i: bigint) {
    return this.values.has(i);
  }
  private changed(values: VectorMap<V>): VectorEditor<V, M> {
    return values === this.values
      ? this
      : new VectorEditor(this.basin, values, this.consumer);
  }
  set(i: bigint, v: V) {
    return this.changed(this.values.set(i, v));
  }
  delete(i: bigint) {
    return this.changed(this.values.delete(i));
  }
  resize(length: bigint) {
    return this.changed(this.values.resize(length));
  }
  push(v: V) {
    return this.changed(this.values.push(v));
  }
  pop() {
    return this.changed(this.values.pop());
  }
  entries() {
    return this.values.entries();
  }
  store(): Promise<Vector<V, M>> {
    return Vector.buildEntries(
      this.basin,
      this.length,
      this.entries(),
      this.consumer,
    );
  }
}
