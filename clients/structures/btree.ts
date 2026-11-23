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
} from "./core";
import { Reference } from "../flexbuffer";
import { type Consumer } from "./trie";
import { pack, built, type Built } from "./packed";
export const BTREE = ".btree-node/";
export type BTreeHeader = import("./types").BTreeNode_S0<{
  [index: number]: { Summary: unknown; Value: unknown };
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
      rows.push({ key: bytes, value: v, summary: await c.entry(bytes, v) });
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
          part.length ? await c.combine(part.map((r) => r.summary)) : c.empty,
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
  private parts(r: Reference) {
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
    return { h, f, keys, values, children };
  }
  async getView(raw: Uint8Array | string): Promise<Reference | undefined> {
    const k = key(raw),
      h = this.root[5] as BTreeHeader;
    if (!h.keys || compare(k, h.keys[0]) < 0 || compare(k, h.keys[1]) > 0)
      return;
    let r = await this.basin.load(this.root);
    for (let depth = 0; depth < 256; depth++) {
      const { keys, values, children } = this.parts(r);
      let lo = 0,
        hi = keys.length();
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compare(keys.get(mid).blobValue()!, k) < 0) lo = mid + 1;
        else hi = mid;
      }
      if (lo < keys.length() && equal(keys.get(lo).blobValue()!, k))
        return values.get(lo);
      if (children.isNull()) return;
      const next = children.get(lo);
      if (next.isMap()) r = next;
      else {
        const e = edgeFrom(next),
          h = e[5] as BTreeHeader;
        if (!h.keys || compare(k, h.keys[0]) < 0 || compare(k, h.keys[1]) > 0)
          return;
        r = await this.basin.load(e);
      }
    }
    throw Error("B-tree nesting limit");
  }
  async get(raw: Uint8Array | string): Promise<V | undefined> {
    const r = await this.getView(raw);
    return r === undefined ? undefined : object<V>(r);
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
