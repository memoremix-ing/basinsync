/** Experimental canonical B+tree: values in leaves, larger key-only routing budgets. */
import { Reference } from "../flexbuffer";
import {
  Basin,
  DOMAIN,
  u32,
  type Edge,
  type Node,
  type Link,
  link,
  capability,
  check,
  key,
  compare,
  equal,
  object,
  edgeFrom,
  validateNode,
  validateEdge,
  distinct,
  isPromiseLike,
} from "./core";
import { type Consumer } from "./trie";
import { built, type Built } from "./packed";
import { type Operation, resolveOperation } from "./operation";
export const BPLUS = ".bplus-node/";
export type BPlusOptions = {
  leafKeys?: number;
  branchChildren?: number;
  leafInline?: number;
  branchInline?: number;
};
type Policy = Required<BPlusOptions>;
export type BPlusHeader = {
  count: bigint;
  depth: number;
  inlined: number;
  routing: number;
  keys: null | [Uint8Array, Uint8Array];
  policy: Policy;
};
type Hint = { keys: [Uint8Array, Uint8Array]; link: Link; sha384: Uint8Array };
const policy = (o: BPlusOptions): Policy => {
  const p = {
    leafKeys: o.leafKeys ?? 127,
    branchChildren: o.branchChildren ?? 128,
    leafInline: o.leafInline ?? 1280,
    branchInline: o.branchInline ?? 8192,
  };
  check(
    Number.isInteger(p.leafKeys) && p.leafKeys >= 1 && p.leafKeys <= 65535,
    "invalid B+tree leaf capacity",
  );
  check(
    Number.isInteger(p.branchChildren) &&
      p.branchChildren >= 2 &&
      p.branchChildren <= 256,
    "invalid B+tree fanout",
  );
  for (const n of [p.leafInline, p.branchInline])
    check(
      Number.isSafeInteger(n) && n >= 1 && n <= 0xffffffff,
      "invalid B+tree inline budget",
    );
  return p;
};
function header(h: BPlusHeader) {
  policy(h.policy);
  check(
    typeof h.count === "bigint" &&
      h.count >= 0n &&
      Number.isInteger(h.depth) &&
      h.depth >= 0 &&
      h.depth < 256 &&
      Number.isSafeInteger(h.inlined) &&
      h.inlined >= 0 &&
      Number.isSafeInteger(h.routing) &&
      h.routing >= 0,
    "invalid B+tree header",
  );
  check(
    h.keys === null ||
      (Array.isArray(h.keys) &&
        h.keys.length === 2 &&
        h.keys.every((k) => k instanceof Uint8Array) &&
        compare(h.keys[0], h.keys[1]) <= 0),
    "invalid B+tree bounds",
  );
  return h;
}
const contains = (h: BPlusHeader, k: Uint8Array) =>
  h.keys !== null && compare(k, h.keys[0]) >= 0 && compare(k, h.keys[1]) <= 0;
function lower(keys: Uint8Array[], k: Uint8Array, upper = false) {
  let lo = 0,
    hi = keys.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (compare(keys[m], k) < 0 || (upper && equal(keys[m], k))) lo = m + 1;
    else hi = m;
  }
  return lo;
}
export class BPlusTree<V = unknown, M = null> {
  constructor(
    readonly basin: Basin,
    readonly root: Edge,
    readonly consumer: Consumer<V, M>,
  ) {
    u32(consumer.migration);
    validateEdge(root);
    check(
      root[1] === DOMAIN &&
        root[2] === BPLUS &&
        root[6][0] === consumer.migration,
      "unsupported B+tree",
    );
    header(root[5] as BPlusHeader);
  }
  static async build<V, M>(
    basin: Basin,
    input: Iterable<[Uint8Array | string, V]>,
    c: Consumer<V, M>,
    options: BPlusOptions = {},
  ): Promise<BPlusTree<V, M>> {
    u32(c.migration);
    const p = policy(options);
    check(
      p.branchChildren <= (basin.options.maxDegree ?? 320),
      "B+tree fanout exceeds degree budget",
    );
    const rows: { key: Uint8Array; value: V; summary: M }[] = [];
    for (const [raw, value] of input) {
      const k = key(raw),
        s = c.entry(k, value);
      rows.push({ key: k, value, summary: isPromiseLike(s) ? await s : s });
    }
    rows.sort((a, b) => compare(a.key, b.key));
    for (let i = 1; i < rows.length; i++)
      check(!equal(rows[i - 1].key, rows[i].key), "duplicate B+tree key");
    const byEdge = new Map<string, Node>();
    type Part = Built & { start: number; end: number };
    const aggregate = async (start: number, end: number) => {
      const s =
        start === end
          ? c.empty
          : c.combine(rows.slice(start, end).map((r) => r.summary));
      return isPromiseLike(s) ? await s : s;
    };
    const make = async (
      start: number,
      end: number,
      children: Part[] = [],
    ): Promise<Part> => {
      const leaf = !children.length,
        own = leaf ? rows.slice(start, end) : [],
        keys = leaf
          ? own.map((r) => r.key)
          : children.slice(1).map((ch) => rows[ch.start].key),
        refs = leaf && c.edges ? own.flatMap((r) => c.edges!(r.value)) : [];
      let edges = distinct([...refs, ...children.flatMap((ch) => ch.edges)]),
        inlined = leaf
          ? own.length
          : children.reduce(
              (n, ch) => n + (ch.node[5] as BPlusHeader).inlined,
              0,
            ),
        routing = leaf
          ? 0
          : keys.length +
            children.reduce(
              (n, ch) => n + (ch.node[5] as BPlusHeader).routing,
              0,
            );
      const cut =
        !leaf &&
        (inlined > p.leafInline ||
          routing > p.branchInline ||
          edges.length > (basin.options.maxDegree ?? 320));
      const slots: (Node | Edge)[] = [];
      if (cut) {
        edges = refs.slice();
        for (const ch of children) {
          const e = await basin.seal(ch.node, ch.edges);
          byEdge.set(capability(link(e)), ch.node);
          edges.push(e);
          slots.push(e);
        }
        inlined = 0;
        routing = keys.length;
      } else slots.push(...children.map((ch) => ch.node));
      const h: BPlusHeader = {
        count: BigInt(end - start),
        depth: leaf ? 0 : (children[0].node[5] as BPlusHeader).depth + 1,
        inlined,
        routing,
        keys: end > start ? [rows[start].key, rows[end - 1].key] : null,
        policy: p,
      };
      const out = built(
        basin,
        BPLUS,
        h,
        [
          c.migration,
          await aggregate(start, end),
          keys,
          leaf ? own.map((r) => r.value) : null,
          leaf ? null : slots,
          [],
          [],
        ],
        distinct(edges),
      );
      return { ...out, start, end };
    };
    let level: Part[] = [],
      groups = Math.max(1, Math.ceil(rows.length / p.leafKeys)),
      at = 0;
    for (let i = 0; i < groups; i++) {
      const size =
        Math.floor(rows.length / groups) + (i < rows.length % groups ? 1 : 0);
      level.push(await make(at, at + size));
      at += size;
    }
    while (level.length > 1) {
      const next: Part[] = [],
        groups = Math.ceil(level.length / p.branchChildren);
      let at = 0;
      for (let i = 0; i < groups; i++) {
        const size =
            Math.floor(level.length / groups) +
            (i < level.length % groups ? 1 : 0),
          children = level.slice(at, at + size);
        next.push(
          await make(children[0].start, children.at(-1)!.end, children),
        );
        at += size;
      }
      level = next;
    }
    const root = level[0];
    const spine = (last: boolean): Array<Hint | null> => {
      const hints: Array<Hint | null> = Array(root.node[3].height).fill(null);
      let n = root.node;
      for (let depth = 0; depth < 256; depth++) {
        const children = n[6][4] as (Node | Edge)[] | null;
        if (!children) return hints;
        const ch = children[last ? children.length - 1 : 0];
        if (Array.isArray(ch)) {
          hints[ch[3].height] = {
            keys: (ch[5] as BPlusHeader).keys!,
            link: link(ch),
            sha384: ch[6].sha384,
          };
          n = byEdge.get(capability(link(ch)))!;
          check(n, "missing B+tree builder child");
        } else n = ch;
      }
      throw Error("B+tree nesting limit");
    };
    root.node[6][5] = spine(false);
    root.node[6][6] = spine(true);
    return new BPlusTree(basin, await basin.seal(root.node, root.edges), c);
  }
  private readonly plans = new WeakMap<
    Reference,
    ReturnType<BPlusTree<V, M>["parse"]>
  >();
  private parse(r: Reference) {
    validateNode(r, BPLUS);
    const h = header(object<BPlusHeader>(r.get("5"))),
      f = r.get("6"),
      ks = f.get(2),
      values = f.get(3),
      children = f.get(4);
    check(
      f.length() === 7 && f.get(0).intValue() === this.consumer.migration,
      "unsupported B+tree migration",
    );
    check(ks.isVector() && !ks.isExtension(), "invalid B+tree keys");
    for (const i of [5, 6])
      check(
        f.get(i).isVector() && !f.get(i).isExtension(),
        "invalid B+tree hints",
      );
    const keys = Array.from({ length: ks.length() }, (_, i) =>
      ks.get(i).blobValue()!,
    );
    for (let i = 1; i < keys.length; i++)
      check(compare(keys[i - 1], keys[i]) < 0, "invalid B+tree key order");
    check(
      h.depth
        ? values.isNull() &&
            children.isVector() &&
            !children.isExtension() &&
            children.length() === keys.length + 1 &&
            children.length() <= h.policy.branchChildren
        : children.isNull() &&
            values.isVector() &&
            !values.isExtension() &&
            values.length() === keys.length &&
            keys.length <= h.policy.leafKeys,
      "invalid B+tree node",
    );
    return {
      h,
      f,
      keys,
      values,
      children,
      sources: new Map<number, Reference | Edge>(),
    };
  }
  private parts(r: Reference) {
    let p = this.plans.get(r);
    if (!p) {
      p = this.parse(r);
      this.plans.set(r, p);
    }
    return p;
  }
  private *resume(
    e: Edge,
    k: Uint8Array,
    depth: number,
  ): Generator<PromiseLike<unknown>, Reference | undefined, unknown> {
    const r = (yield this.basin.load(e)) as Reference;
    const next = this.seek(r, k, depth);
    return typeof next === "function" ? yield* next() : next;
  }
  private seek(
    r: Reference,
    k: Uint8Array,
    depth: number,
  ): Operation<Reference | undefined> {
    for (;;) {
      check(depth++ < 256, "B+tree nesting limit");
      const p = this.parts(r);
      if (!contains(p.h, k)) return;
      if (!p.h.depth) {
        const at = lower(p.keys, k);
        return at < p.keys.length && equal(p.keys[at], k)
          ? p.values.get(at)
          : undefined;
      }
      const at = lower(p.keys, k, true);
      let next = p.sources.get(at);
      if (!next) {
        const ch = p.children.get(at);
        next = ch.isMap() ? ch : edgeFrom(ch);
        p.sources.set(at, next);
      }
      if (Array.isArray(next)) {
        if (!contains(header(next[5] as BPlusHeader), k)) return;
        const ready = this.basin.peek(next);
        if (!ready) return () => this.resume(next as Edge, k, depth);
        r = ready;
      } else r = next;
    }
  }
  getViewOrDefer(raw: Uint8Array | string): Operation<Reference | undefined> {
    const k = key(raw);
    validateEdge(this.root);
    if (!contains(header(this.root[5] as BPlusHeader), k)) return;
    const ready = this.basin.peek(this.root);
    return ready ? this.seek(ready, k, 0) : () => this.resume(this.root, k, 0);
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
  async get(
    raw: Uint8Array | string,
    options: { shortcuts?: boolean } = {},
  ): Promise<V | undefined> {
    if (options.shortcuts && this.basin.storage.resolve) {
      const k = key(raw),
        root = await this.basin.load(this.root),
        p = this.parts(root),
        hints = [
          ...object<Array<Hint | null>>(p.f.get(5)),
          ...object<Array<Hint | null>>(p.f.get(6)),
        ]
          .filter(
            (h): h is Hint =>
              h !== null &&
              compare(k, h.keys[0]) >= 0 &&
              compare(k, h.keys[1]) <= 0,
          )
          .sort((a, b) => a.link.height - b.link.height);
      for (const hint of hints)
        try {
          const e = await this.basin.storage.resolve(hint.link);
          if (!e) continue;
          check(
            capability(link(e)) === capability(hint.link) &&
              equal(e[6].sha384, hint.sha384),
            "B+tree shortcut identity mismatch",
          );
          const h = header(e[5] as BPlusHeader);
          check(
            h.keys &&
              equal(h.keys[0], hint.keys[0]) &&
              equal(h.keys[1], hint.keys[1]),
            "B+tree shortcut bounds mismatch",
          );
          const r = await resolveOperation(
            this.seek(await this.basin.load(e), k, 0),
          );
          return r === undefined ? undefined : object<V>(r);
        } catch {
          /* A failed optional shortcut falls back to strong traversal. */
        }
    }
    return resolveOperation(this.getOrDefer(raw));
  }
  async *entries(
    from: Uint8Array | string = new Uint8Array(),
    to?: Uint8Array | string,
    accept?: (header: BPlusHeader, summary: M) => boolean,
  ): AsyncGenerator<[Uint8Array, V]> {
    const lo = key(from),
      hi = to === undefined ? undefined : key(to);
    check(!hi || compare(lo, hi) <= 0, "invalid B+tree range");
    const visit = async function* (
      self: BPlusTree<V, M>,
      r: Reference,
      depth: number,
    ): AsyncGenerator<[Uint8Array, V]> {
      check(depth < 256, "B+tree nesting limit");
      const p = self.parts(r);
      if (
        (accept && !accept(p.h, object<M>(p.f.get(1)))) ||
        !p.h.keys ||
        compare(p.h.keys[1], lo) < 0 ||
        (hi && compare(p.h.keys[0], hi) >= 0)
      )
        return;
      if (!p.h.depth) {
        for (
          let i = lower(p.keys, lo);
          i < p.keys.length && (!hi || compare(p.keys[i], hi) < 0);
          i++
        )
          yield [new Uint8Array(p.keys[i]), object<V>(p.values.get(i))];
      } else
        for (let i = 0; i < p.children.length(); i++) {
          const ch = p.children.get(i);
          if (ch.isMap()) yield* visit(self, ch, depth + 1);
          else {
            const e = edgeFrom(ch),
              h = header(e[5] as BPlusHeader);
            if (
              h.keys &&
              compare(h.keys[1], lo) >= 0 &&
              (!hi || compare(h.keys[0], hi) < 0) &&
              (!accept || accept(h, e[6][1] as M))
            )
              yield* visit(self, await self.basin.load(e), depth + 1);
          }
        }
    };
    if (
      !accept ||
      accept(header(this.root[5] as BPlusHeader), this.root[6][1] as M)
    )
      yield* visit(this, await this.basin.load(this.root), 0);
  }
}
