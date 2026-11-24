import {
  type Bitmap,
  vectorBits,
  emptyBitmap,
  has,
  rank,
  changeBit,
  bitmapBytes,
  readBitmap,
  bitmapCount,
} from "./vector-bitmap";
import {
  type VectorMutation,
  type VectorMutationMetrics,
  VectorMap,
} from "./logical-vector";
import { type Operation, resolveOperation } from "./operation";
import {
  Basin,
  type Node,
  type Link,
  link,
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
  [migration: number]: { Summary: unknown; Value: unknown };
}>[5];
const index = (n: bigint) => {
  check(typeof n === "bigint" && n >= 0n, "invalid vector index");
  return n;
};
const indexBytes = (i: bigint) => {
  let h = i.toString(16);
  return key(h.length % 2 ? `0${h}` : h);
};
function checkedHeader(h: VectorHeader): VectorHeader {
  check(
    typeof h.length === "bigint" &&
      typeof h.count === "bigint" &&
      h.length >= 0n &&
      h.count >= 0n &&
      h.count <= h.length,
    "invalid vector counts",
  );
  vectorBits(h.bits);
  u32(h.shift);
  u32(h.inlined);
  check(
    h.shift % h.bits === 0 && h.shift / h.bits < 256,
    "invalid vector shift",
  );
  return h;
}
export class Vector<V = unknown, M = null, R extends Edge | Reference = Edge> {
  constructor(
    readonly basin: Basin,
    readonly root: R,
    readonly consumer: Consumer<V, M>,
  ) {
    if (Array.isArray(root)) {
      validateEdge(root);
      checkedHeader(root[5] as VectorHeader);
      check(
        root[1] === DOMAIN &&
          root[2] === VECTOR &&
          root[6][0] === consumer.migration,
        "unsupported vector migration",
      );
    } else {
      validateNode(root, VECTOR);
      checkedHeader(object<VectorHeader>(root.get("5")));
      check(
        root.get("6").get(0).intValue() === consumer.migration,
        "unsupported vector migration",
      );
    }
  }
  private header(): VectorHeader {
    return Array.isArray(this.root)
      ? (this.root[5] as VectorHeader)
      : object<VectorHeader>(this.root.get("5"));
  }
  private summary(): M {
    return Array.isArray(this.root)
      ? (this.root[6][1] as M)
      : object<M>(this.root.get("6").get(1));
  }
  get bits() {
    return this.header().bits;
  }
  get length() {
    return this.header().length;
  }
  static async build<V, M>(
    basin: Basin,
    values: Iterable<V>,
    c: Consumer<V, M>,
    options: { bits?: number } = {},
  ): Promise<Vector<V, M>> {
    const rows: [bigint, V][] = [];
    for (const v of values) rows.push([BigInt(rows.length), v]);
    return Vector.buildEntries(basin, BigInt(rows.length), rows, c, options);
  }
  static async buildNode<V, M>(
    basin: Basin,
    values: Iterable<V>,
    c: Consumer<V, M>,
    options: { bits?: number } = {},
  ): Promise<Built> {
    const rows: [bigint, V][] = [];
    for (const v of values) rows.push([BigInt(rows.length), v]);
    return Vector.buildNodeEntries(
      basin,
      BigInt(rows.length),
      rows,
      c,
      options,
    );
  }
  static async buildEntries<V, M>(
    basin: Basin,
    length: bigint,
    input: Iterable<[bigint, V]>,
    c: Consumer<V, M>,
    options: { bits?: number } = {},
  ): Promise<Vector<V, M>> {
    const b = await Vector.buildNodeEntries(basin, length, input, c, options);
    return new Vector(basin, await basin.seal(b.node, b.edges), c);
  }
  static async buildNodeEntries<V, M>(
    basin: Basin,
    length: bigint,
    input: Iterable<[bigint, V]>,
    c: Consumer<V, M>,
    options: { bits?: number } = {},
  ): Promise<Built> {
    index(length);
    const bits = vectorBits(options.bits);
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
    while (length > 1n << BigInt(shift + bits)) shift += bits;
    check(shift / bits < 256, "vector nesting limit");
    const build = async (
      part: typeof rows,
      base: bigint,
      span: bigint,
      shift: number,
    ): Promise<Built> => {
      let bitmap = emptyBitmap(bits);
      const children: Built[] = [],
        values: V[] = [],
        width = 1n << BigInt(shift);
      let position = 0;
      for (let slot = 0; slot < 1 << bits; slot++) {
        const lo = base + BigInt(slot) * width,
          end = lo + width,
          begin = position;
        while (position < part.length && part[position].index < end) position++;
        const at = part.slice(begin, position);
        if (!at.length) continue;
        bitmap = changeBit(bitmap, slot, true);
        if (shift === 0) values.push(at[0].value);
        else
          children.push(
            await build(
              at,
              lo,
              span - BigInt(slot) * width < width
                ? span - BigInt(slot) * width
                : width,
              shift - bits,
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
        {
          bits,
          length: span,
          count: BigInt(part.length),
          shift,
          inlined: p.inlined,
        },
        [
          c.migration,
          summary,
          bitmapBytes(bitmap, bits),
          shift === 0 ? values : p.slots,
        ],
        p.edges,
      );
    };
    return build(rows, 0n, length, shift);
  }
  private readonly plans = new WeakMap<
    Reference,
    {
      h: VectorHeader;
      f: Reference;
      bitmap: Bitmap;
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
    const bitmap = readBitmap(object<Uint8Array>(f.get(2)), h.bits),
      slots = f.get(3);
    check(
      slots.isVector() &&
        !slots.isExtension() &&
        slots.length() === bitmapCount(bitmap),
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
    if (i >= this.length || this.header().count === 0n) return;
    const digits: number | string =
      i <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(i) : i.toString(2);
    const r = Array.isArray(this.root) ? this.basin.peek(this.root) : this.root;
    return r
      ? this.seek(r as Reference, digits, 0)
      : () => this.resume(this.root as Edge, digits, 0);
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
      check(h.bits === this.bits, "inconsistent vector bits");
      const slot =
        typeof i === "number"
          ? Math.floor(i / 2 ** h.shift) % (1 << h.bits)
          : parseInt(
              i.slice(
                Math.max(0, i.length - h.shift - h.bits),
                Math.max(0, i.length - h.shift),
              ) || "0",
              2,
            );
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
  /** Ready-only probe; the returned continuation initiates no I/O until resumed. */
  findLastOrDefer(
    acceptValue: (value: V) => boolean,
    acceptSummary: (summary: M) => boolean = () => true,
  ): Operation<[bigint, V] | undefined> {
    const missing = Symbol();
    const inspect = (
      source: Reference | Edge,
      base: bigint,
      depth: number,
    ): [bigint, V] | undefined | typeof missing => {
      check(depth < 256, "vector nesting limit");
      if (Array.isArray(source) && !acceptSummary(source[6][1] as M)) return;
      const r = Array.isArray(source) ? this.basin.peek(source) : source;
      if (!r) return missing;
      const { h, f, bitmap, slots } = this.parts(r);
      check(h.bits === this.bits, "inconsistent vector bits");
      if (!h.count || !acceptSummary(object<M>(f.get(1)))) return;
      for (let slot = (1 << h.bits) - 1; slot >= 0; slot--)
        if (has(bitmap, slot)) {
          const at = slots.get(rank(bitmap, slot)),
            index = base + (BigInt(slot) << BigInt(h.shift));
          if (!h.shift) {
            const v = object<V>(at);
            if (acceptValue(v)) return [index, v];
          } else {
            const found = inspect(
              at.isMap() ? at : edgeFrom(at),
              index,
              depth + 1,
            );
            if (found !== undefined) return found;
          }
        }
    };
    const found = inspect(this.root, 0n, 0);
    if (found !== missing) return found;
    const self = this;
    return function* () {
      return (yield self.findLast(acceptValue, acceptSummary)) as
        [bigint, V] | undefined;
    };
  }
  /** Last matching index; summaries prune entire stored branches before GETs. */
  async findLast(
    acceptValue: (value: V) => boolean,
    acceptSummary: (summary: M) => boolean = () => true,
  ): Promise<[bigint, V] | undefined> {
    if (!this.header().count || !acceptSummary(this.summary())) return;
    const walk = async (
      r: Reference,
      base: bigint,
      depth: number,
    ): Promise<[bigint, V] | undefined> => {
      check(depth < 256, "vector nesting limit");
      const { h, f, bitmap, slots } = this.parts(r);
      check(h.bits === this.bits, "inconsistent vector bits");
      if (!h.count || !acceptSummary(object<M>(f.get(1)))) return;
      for (let slot = (1 << h.bits) - 1; slot >= 0; slot--)
        if (has(bitmap, slot)) {
          const at = slots.get(rank(bitmap, slot)),
            i = base + (BigInt(slot) << BigInt(h.shift));
          if (!h.shift) {
            const value = object<V>(at);
            if (acceptValue(value)) return [i, value];
          } else {
            let child: Reference;
            if (at.isMap()) child = at;
            else {
              const e = edgeFrom(at);
              if (!acceptSummary(e[6][1] as M)) continue;
              child = await this.basin.load(e);
            }
            const found = await walk(child, i, depth + 1);
            if (found) return found;
          }
        }
    };
    return walk(
      Array.isArray(this.root) ? await this.basin.load(this.root) : this.root,
      0n,
      0,
    );
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
      self: Vector<V, M, R>,
      r: Reference,
      base: bigint,
      depth: number,
    ): AsyncGenerator<[bigint, V]> {
      check(depth < 256, "vector nesting limit");
      const { h, f, bitmap, slots } = self.parts(r);
      check(h.bits === self.bits, "inconsistent vector bits");
      if (
        base >= to ||
        base + h.length <= from ||
        !h.count ||
        (accept && !accept(h, object<M>(f.get(1))))
      )
        return;
      const width = 1n << BigInt(h.shift);
      for (let slot = 0; slot < 1 << h.bits; slot++)
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
    const h = this.header();
    if (
      from < to &&
      from < this.length &&
      h.count &&
      (!accept || accept(h, this.summary()))
    )
      yield* visit(
        this,
        Array.isArray(this.root) ? await this.basin.load(this.root) : this.root,
        0n,
        0,
      );
  }
  /** Load once for synchronous path-copied edits; store explicitly after a batch. */
  async edit(): Promise<VectorEditor<V, M>> {
    const rows: [bigint, V][] = [];
    for await (const row of this.entries()) rows.push(row);
    return VectorEditor.from(this.basin, this.length, rows, this.consumer, {
      bits: this.bits,
    });
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
      { bits: this.bits },
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
    options: { bits?: number } = {},
  ): VectorEditor<V, M> {
    return new VectorEditor(
      basin,
      VectorMap.from(length, input, vectorBits(options.bits)),
      consumer,
    );
  }
  get bits() {
    return this.values.bits;
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
  mutate(metrics?: VectorMutationMetrics): VectorEditorMutation<V, M> {
    const scope = this.values.mutate(metrics),
      wrap = (values: VectorMap<V>) =>
        new VectorEditor(this.basin, values, this.consumer);
    return {
      get bits() {
        return scope.bits;
      },
      get length() {
        return scope.length;
      },
      get size() {
        return scope.size;
      },
      get: (i) => scope.get(i),
      has: (i) => scope.has(i),
      set: (i, v) => scope.set(i, v),
      delete: (i) => scope.delete(i),
      resize: (n) => scope.resize(n),
      push: (v) => scope.push(v),
      pop: () => scope.pop(),
      entries: () => scope.entries(),
      snapshot: () => wrap(scope.snapshot()),
      finish: () => wrap(scope.finish()),
      abort: () => scope.abort(),
    };
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
      { bits: this.bits },
    );
  }
}

/** Weak left/right spines of stored vector children, indexed by basin height. */
async function vectorSpine(
  basin: Basin,
  root: Node | Edge,
  last: boolean,
): Promise<(Link | null)[]> {
  const spine: (Link | null)[] = new Array(root[3].height).fill(null);
  let node = Array.isArray(root) ? object<Node>(await basin.load(root)) : root;
  for (let depth = 0; depth < 256; depth++) {
    const h = node[5] as import("./vector").VectorHeader;
    if (!h.shift || !h.count) return spine;
    const slots = node[6][3] as (Node | Edge)[],
      at = slots[last ? slots.length - 1 : 0];
    if (!Array.isArray(at)) node = at;
    else {
      spine[at[3].height] = link(at);
      node = object<Node>(await basin.load(at));
    }
  }
  throw Error("vector nesting limit");
}
/** Weak shortcuts only; the vector's normal edges retain these nodes. */
export async function vectorBoundaryLinks(
  basin: Basin,
  root: Node | Edge,
): Promise<{ leading: (Link | null)[]; lagging: (Link | null)[] }> {
  const [leading, lagging] = await Promise.all([
    vectorSpine(basin, root, false),
    vectorSpine(basin, root, true),
  ]);
  return { leading, lagging };
}

export type VectorEditorMutation<V, M> = Omit<
  VectorMutation<V>,
  "snapshot" | "finish"
> & { snapshot(): VectorEditor<V, M>; finish(): VectorEditor<V, M> };
export type { VectorMutation, VectorMutationMetrics } from "./logical-vector";
