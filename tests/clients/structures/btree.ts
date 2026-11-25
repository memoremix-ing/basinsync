import {
  Basin,
  Edge,
  DOMAIN,
  check,
  key,
  compare,
  equal,
  hex,
  object,
  edgeFrom,
  validateNode,
  u32,
  validateEdge,
  isPromiseLike,
} from "./core";
import { Reference } from "../flexbuffer";
import { type Consumer } from "./trie";
import { pack, built, type Built } from "./packed";
import { type Operation, resolveOperation } from "./operation";
import { exportBTree, type BTreeChange } from "./btree-export";
import { summaryReuse } from "./summary";
import { TrieMap } from "./logical-trie";
import { BTreeMap } from "./logical-btree";
export { BTreeMap } from "./logical-btree";
export const BTREE = ".btree-node/";
export type BTreeHeader = import("./types").BTreeNode_S0<{
  [migration: number]: { Summary: unknown; Value: unknown };
}>[5];
function checkedHeader(h: BTreeHeader): BTreeHeader {
  check(typeof h.count === "bigint" && h.count >= 0n, "invalid B-tree header");
  u32(h.depth);
  u32(h.inlined);
  check(h.depth < 256, "B-tree nesting limit");
  check(
    h.keys === null ||
      (Array.isArray(h.keys) &&
        h.keys.length === 2 &&
        h.keys.every((v) => v instanceof Uint8Array) &&
        compare(h.keys[0], h.keys[1]) <= 0),
    "invalid B-tree key bounds",
  );
  return h;
}
export class BTree<V = unknown, M = null> {
  constructor(
    readonly basin: Basin,
    readonly root: Edge,
    readonly consumer: Consumer<V, M>,
  ) {
    validateEdge(root);
    checkedHeader(root[5] as BTreeHeader);
    check(
      root[1] === DOMAIN &&
        root[2] === BTREE &&
        root[6][0] === consumer.migration,
      "unsupported B-tree migration",
    );
  }
  static async build<V, M>(
    basin: Basin,
    input: Iterable<[Uint8Array | string, V]>,
    c: Consumer<V, M>,
  ): Promise<BTree<V, M>> {
    u32(c.migration);
    const rows = [] as { key: Uint8Array; value: V; summary: M }[];
    for (const [k, v] of input) {
      const bytes = key(k);
      const summary = c.entry(bytes, v);
      rows.push({
        key: bytes,
        value: v,
        summary: isPromiseLike(summary) ? await summary : summary,
      });
    }
    rows.sort((a, b) => compare(a.key, b.key));
    for (let i = 1; i < rows.length; i++)
      check(!equal(rows[i - 1].key, rows[i].key), "duplicate B-tree key");
    const capacity = (depth: number) =>
      Math.min(Number.MAX_SAFE_INTEGER, 32 ** (depth + 1) - 1);
    let depth = 0;
    while (rows.length > capacity(depth)) depth++;
    const build = async (
      part: typeof rows,
      depth: number,
      root: boolean,
    ): Promise<Built> => {
      const own: typeof rows = [],
        children: Built[] = [];
      if (!depth) own.push(...part);
      else {
        const count = Math.max(
            root ? 2 : 16,
            Math.ceil((part.length + 1) / (capacity(depth - 1) + 1)),
          ),
          left = part.length - count + 1,
          base = Math.floor(left / count),
          extra = left % count;
        let at = 0;
        for (let i = 0; i < count; i++) {
          const size = base + (i < extra ? 1 : 0);
          children.push(
            await build(part.slice(at, at + size), depth - 1, false),
          );
          at += size;
          if (i < count - 1) own.push(part[at++]);
        }
        check(at === part.length, "B-tree partition mismatch");
      }
      const p = await pack(
        basin,
        children,
        own.length,
        c.edges ? own.flatMap((r) => c.edges!(r.value)) : [],
      );
      const combined = part.length
        ? c.combine(part.map((r) => r.summary))
        : c.empty;
      const summary = isPromiseLike(combined) ? await combined : combined;
      return built(
        basin,
        BTREE,
        {
          count: BigInt(part.length),
          depth,
          inlined: p.inlined,
          keys: part.length ? [part[0].key, part[part.length - 1].key] : null,
        },
        [
          c.migration,
          summary,
          own.map((r) => r.key),
          own.map((r) => r.value),
          depth ? p.slots : null,
        ],
        p.edges,
      );
    };
    const b = await build(rows, depth, true);
    return new BTree(basin, await basin.seal(b.node, b.edges), c);
  }
  private readonly plans = new WeakMap<
    Reference,
    ReturnType<BTree<V, M>["parseParts"]>
  >();
  private parts(r: Reference) {
    let p = this.plans.get(r);
    if (!p) {
      p = this.parseParts(r);
      this.plans.set(r, p);
    }
    return p;
  }
  private parseParts(r: Reference) {
    validateNode(r, BTREE);
    const h = checkedHeader(object<BTreeHeader>(r.get("5"))),
      f = r.get("6");
    u32(h.depth);
    check(h.count >= 0n && h.depth < 256, "invalid B-tree header");
    check(
      f.length() === 5 && f.get(0).intValue() === this.consumer.migration,
      "unsupported B-tree migration",
    );
    const keys = f.get(2),
      values = f.get(3),
      children = f.get(4);
    check(
      keys.isVector() &&
        !keys.isExtension() &&
        values.isVector() &&
        !values.isExtension() &&
        keys.length() <= 31 &&
        keys.length() === values.length() &&
        (h.depth
          ? children.isVector() &&
            !children.isExtension() &&
            children.length() === keys.length() + 1
          : children.isNull()),
      "invalid B-tree node",
    );
    const bytes = Array.from({ length: keys.length() }, (_, i) =>
      keys.get(i).blobValue()!,
    );
    for (let i = 1; i < bytes.length; i++)
      check(compare(bytes[i - 1], bytes[i]) < 0, "invalid B-tree key order");
    return {
      h,
      f,
      keys,
      values,
      children,
      bytes,
      sources: new Map<number, Reference | Edge>(),
    };
  }
  /** Ready reads allocate no Promise; missing edges suspend at the traversal boundary. */
  getViewOrDefer(raw: Uint8Array | string): Operation<Reference | undefined> {
    const k = key(raw);
    validateEdge(this.root);
    const h = checkedHeader(this.root[5] as BTreeHeader);
    if (!h.keys || compare(k, h.keys[0]) < 0 || compare(k, h.keys[1]) > 0)
      return;
    const cached = this.basin.peek(this.root);
    return cached
      ? this.seek(cached, k, 0)
      : () => this.resume(this.root, k, 0);
  }
  private *resume(
    edge: Edge,
    k: Uint8Array,
    depth: number,
  ): Generator<PromiseLike<unknown>, Reference | undefined, unknown> {
    const r = (yield this.basin.load(edge)) as Reference;
    const next = this.seek(r, k, depth);
    return typeof next === "function" ? yield* next() : next;
  }
  private seek(
    r: Reference,
    k: Uint8Array,
    depth: number,
  ): Operation<Reference | undefined> {
    for (;;) {
      check(depth++ < 256, "B-tree nesting limit");
      const p = this.parts(r);
      let lo = 0,
        hi = p.bytes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compare(p.bytes[mid], k) < 0) lo = mid + 1;
        else hi = mid;
      }
      if (lo < p.bytes.length && equal(p.bytes[lo], k)) return p.values.get(lo);
      if (p.children.isNull()) return;
      let next = p.sources.get(lo);
      if (!next) {
        const at = p.children.get(lo);
        next = at.isMap() ? at : edgeFrom(at);
        p.sources.set(lo, next);
      }
      if (Array.isArray(next)) {
        const h = checkedHeader(next[5] as BTreeHeader);
        if (!h.keys || compare(k, h.keys[0]) < 0 || compare(k, h.keys[1]) > 0)
          return;
        const cached = this.basin.peek(next);
        if (!cached) return () => this.resume(next as Edge, k, depth);
        r = cached;
      } else r = next;
    }
  }
  getOrDefer(raw: Uint8Array | string): Operation<V | undefined> {
    const op = this.getViewOrDefer(raw);
    if (typeof op === "function")
      return function* () {
        const r = yield* op();
        return r === undefined ? undefined : object<V>(r);
      };
    return op === undefined ? undefined : object<V>(op);
  }
  async getView(raw: Uint8Array | string): Promise<Reference | undefined> {
    return resolveOperation(this.getViewOrDefer(raw));
  }
  async get(raw: Uint8Array | string): Promise<V | undefined> {
    return resolveOperation(this.getOrDefer(raw));
  }
  edit(): Promise<BTreeEditor<V, M>> {
    return BTreeEditor.load(this);
  }
  async *entries(
    from: Uint8Array | string = new Uint8Array(),
    to?: Uint8Array | string,
    accept?: (h: BTreeHeader, summary: M) => boolean,
  ): AsyncGenerator<[Uint8Array, V]> {
    const lo = key(from),
      hi = to === undefined ? undefined : key(to);
    check(!hi || compare(lo, hi) <= 0, "invalid B-tree range");
    const intersects = (h: BTreeHeader) =>
      h.keys &&
      compare(h.keys[1], lo) >= 0 &&
      (!hi || compare(h.keys[0], hi) < 0);
    const visit = async function* (
      self: BTree<V, M>,
      r: Reference,
      depth: number,
    ): AsyncGenerator<[Uint8Array, V]> {
      check(depth < 256, "B-tree nesting limit");
      const { h, f, keys, values, children } = self.parts(r);
      if (!intersects(h) || (accept && !accept(h, object<M>(f.get(1))))) return;
      for (let i = 0; i <= keys.length(); i++) {
        if (!children.isNull()) {
          const next = children.get(i);
          if (next.isMap()) yield* visit(self, next, depth + 1);
          else {
            const e = edgeFrom(next),
              h = e[5] as BTreeHeader;
            if (intersects(h) && (!accept || accept(h, e[6][1] as M)))
              yield* visit(self, await self.basin.load(e), depth + 1);
          }
        }
        if (i < keys.length()) {
          const k = keys.get(i).blobValue()!;
          if (compare(k, lo) >= 0 && (!hi || compare(k, hi) < 0))
            yield [k.slice(), object<V>(values.get(i))];
        }
      }
    };
    const h = this.root[5] as BTreeHeader;
    if (intersects(h) && (!accept || accept(h, this.root[6][1] as M)))
      yield* visit(this, await this.basin.load(this.root), 0);
  }
  async update(
    changes: Iterable<[Uint8Array | string, { set: V } | { delete: true }]>,
  ): Promise<BTree<V, M>> {
    const rows = new Map<string, V>();
    for await (const [k, v] of this.entries()) rows.set(hex(k), v);
    for (const [k, c] of changes) {
      const id = hex(key(k));
      if ("delete" in c) rows.delete(id);
      else rows.set(id, c.set);
    }
    return BTree.build(this.basin, rows, this.consumer);
  }
}

/** In-memory edits path-copy; store performs canonical full export. */
export class BTreeEditor<V, M = null> {
  private plan?: {
    source: BTree<V, M>;
    changes: TrieMap<BTreeChange<V>>;
    policy: string;
  };
  static async load<V, M>(source: BTree<V, M>) {
    const rows: [Uint8Array, V][] = [];
    for await (const row of source.entries()) rows.push(row);
    const editor = BTreeEditor.from(source.basin, rows, source.consumer);
    editor.plan = {
      source,
      changes: TrieMap.from([]),
      policy: JSON.stringify(source.basin.options),
    };
    return editor;
  }
  private changed(
    tree: BTreeMap<V>,
    key: Uint8Array | string,
    change: BTreeChange<V>,
  ) {
    const next = new BTreeEditor(this.basin, this.consumer, tree);
    if (this.plan)
      next.plan = { ...this.plan, changes: this.plan.changes.set(key, change) };
    return next;
  }

  constructor(
    readonly basin: Basin,
    readonly consumer: Consumer<V, M>,
    private readonly tree: BTreeMap<V> = BTreeMap.empty(),
  ) {}
  static from<V, M>(
    basin: Basin,
    rows: Iterable<[Uint8Array | string, V]>,
    consumer: Consumer<V, M>,
  ) {
    return new BTreeEditor(basin, consumer, BTreeMap.from(rows));
  }
  get size() {
    return this.tree.size;
  }
  get(k: Uint8Array | string) {
    return this.tree.get(k);
  }
  has(k: Uint8Array | string) {
    return this.tree.has(k);
  }
  set(k: Uint8Array | string, v: V) {
    const next = this.tree.set(k, v);
    return next === this.tree ? this : this.changed(next, k, { set: v });
  }
  delete(k: Uint8Array | string) {
    const next = this.tree.delete(k);
    return next === this.tree ? this : this.changed(next, k, { delete: true });
  }
  entries(from?: Uint8Array | string, to?: Uint8Array | string) {
    return this.tree.entries(from, to);
  }
  async store() {
    if (
      this.plan &&
      summaryReuse(this.consumer) &&
      this.plan.policy === JSON.stringify(this.basin.options)
    )
      return new BTree(
        this.basin,
        await exportBTree(
          this.basin,
          this.plan.source.root,
          this.consumer,
          this.plan.changes.entries(),
        ),
        this.consumer,
      );
    const stored = await BTree.build(
      this.basin,
      this.tree.entries(),
      this.consumer,
    );
    this.plan = {
      source: stored,
      changes: TrieMap.from([]),
      policy: JSON.stringify(this.basin.options),
    };
    return stored;
  }
}
