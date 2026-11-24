/** Rank-aware canonical B-tree export. Changed ranks can invalidate packing boundaries. */
import {
  Basin,
  type Edge,
  type Node,
  check,
  object,
  edgeFrom,
  validateNode,
  distinct,
  compare,
  equal,
  isPromiseLike,
} from "./core";
import { Reference } from "../flexbuffer";
import type { Consumer } from "./trie";
import type { BTreeHeader } from "./btree";
import { built } from "./packed";
export type BTreeChange<V> = { set: V } | { delete: true };
type Row<V> = { kind: "row"; key: Uint8Array; value: V };
type Source<M> = {
  kind: "node";
  source: Reference | Edge;
  h: BTreeHeader;
  summary: M;
  root: boolean;
};
type Piece<V, M> = Row<V> | Source<M>;
const PATH = ".btree-node/";
const capacity = (depth: number) =>
  Math.min(Number.MAX_SAFE_INTEGER, 32 ** (depth + 1) - 1);
const count = <V, M>(p: Piece<V, M>) =>
  p.kind === "row" ? 1 : Number(p.h.count);
const bounds = <V, M>(p: Piece<V, M>) =>
  p.kind === "row" ? [p.key, p.key] : p.h.keys!;
function source<M>(s: Reference | Edge, root = false): Source<M> {
  const h = Array.isArray(s)
    ? (s[5] as BTreeHeader)
    : object<BTreeHeader>(s.get("5"));
  check(
    h.count >= 0n && h.count <= BigInt(Number.MAX_SAFE_INTEGER),
    "B-tree editor count limit",
  );
  return {
    kind: "node",
    source: s,
    h,
    summary: Array.isArray(s) ? (s[6][1] as M) : object<M>(s.get("6").get(1)),
    root,
  };
}
async function expand<V, M>(b: Basin, p: Source<M>): Promise<Piece<V, M>[]> {
  const r = Array.isArray(p.source) ? await b.load(p.source) : p.source;
  validateNode(r, PATH);
  const f = r.get("6"),
    keys = f.get(2),
    values = f.get(3),
    children = f.get(4),
    out: Piece<V, M>[] = [];
  for (let i = 0; i <= keys.length(); i++) {
    if (!children.isNull()) {
      const child = children.get(i);
      out.push(source<M>(child.isMap() ? child : edgeFrom(child)));
    }
    if (i < keys.length())
      out.push({
        kind: "row",
        key: new Uint8Array(keys.get(i).blobValue()!),
        value: object<V>(values.get(i)),
      });
  }
  return out;
}
async function slice<V, M>(
  b: Basin,
  ps: Piece<V, M>[],
  start: number,
  length: number,
): Promise<Piece<V, M>[]> {
  const out: Piece<V, M>[] = [];
  let at = 0;
  for (const p of ps) {
    const n = count(p),
      lo = Math.max(start - at, 0),
      hi = Math.min(start + length - at, n);
    at += n;
    if (lo >= hi) continue;
    if (lo === 0 && hi === n) out.push(p);
    else {
      check(p.kind === "node", "partial B-tree row");
      out.push(...(await slice(b, await expand<V, M>(b, p), lo, hi - lo)));
    }
  }
  check(
    out.reduce((n, p) => n + count(p), 0) === length,
    "B-tree rank mismatch",
  );
  return out;
}
type Result<M> = {
  h: BTreeHeader;
  summary: M;
  node: () => Promise<Node>;
  edges: () => Promise<Edge[]>;
  seal: () => Promise<Edge>;
};
function memo<T>(f: () => Promise<T>) {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
}
function retained<V, M>(b: Basin, p: Source<M>, c: Consumer<V, M>): Result<M> {
  const node = memo(async () =>
    Array.isArray(p.source)
      ? object<Node>(await b.load(p.source))
      : object<Node>(p.source),
  );
  const edges = memo(async () => {
    const refs = (n: Node): Edge[] => {
      const f = n[6],
        out: Edge[] = c.edges ? (f[3] as V[]).flatMap((v) => c.edges!(v)) : [];
      for (const ch of (f[4] as (Node | Edge)[] | null) ?? [])
        out.push(...(Array.isArray(ch) ? [ch] : refs(ch)));
      return distinct(out);
    };
    return refs(await node());
  });
  return {
    h: p.h,
    summary: p.summary,
    node,
    edges,
    seal: memo(async () =>
      Array.isArray(p.source) ? p.source : b.seal(await node(), await edges()),
    ),
  };
}
export async function exportBTree<V, M>(
  b: Basin,
  root: Edge,
  c: Consumer<V, M>,
  changes: Iterable<[Uint8Array, BTreeChange<V>]>,
): Promise<Edge> {
  b.peek(root);
  const edits = [...changes].sort(([a], [z]) => compare(a, z));
  if (!edits.length) return root;
  const lower = (k: Uint8Array) => {
    let lo = 0,
      hi = edits.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(edits[mid][0], k) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const collect = async (p: Piece<V, M>): Promise<Piece<V, M>[]> => {
    if (p.kind === "row") {
      const i = lower(p.key);
      return i < edits.length && equal(edits[i][0], p.key) ? [] : [p];
    }
    if (!p.h.count) return [];
    const [lo, hi] = bounds(p),
      i = lower(lo);
    if (i === edits.length || compare(edits[i][0], hi) > 0) return [p];
    const out: Piece<V, M>[] = [];
    for (const ch of await expand<V, M>(b, p)) out.push(...(await collect(ch)));
    return out;
  };
  const pieces = await collect(source<M>(root, true));
  pieces.push(
    ...edits.flatMap(([key, c]) =>
      "set" in c ? [{ kind: "row" as const, key, value: c.set }] : [],
    ),
  );
  pieces.sort((a, z) => compare(bounds(a)[0], bounds(z)[0]));
  const n = pieces.reduce((n, p) => n + count(p), 0);
  let depth = 0;
  while (n > capacity(depth)) depth++;
  const make = async (
    ps: Piece<V, M>[],
    n: number,
    depth: number,
    isRoot: boolean,
  ): Promise<Result<M>> => {
    if (
      ps.length === 1 &&
      ps[0].kind === "node" &&
      ps[0].h.depth === depth &&
      ps[0].root === isRoot
    )
      return retained(b, ps[0], c);
    const own: Row<V>[] = [],
      children: Result<M>[] = [];
    if (!depth) {
      for (const p of ps)
        if (p.kind === "row") own.push(p);
        else
          for (const ch of await expand<V, M>(b, p)) {
            check(ch.kind === "row", "unexpected B-tree leaf");
            own.push(ch);
          }
    } else {
      const groups = Math.max(
          isRoot ? 2 : 16,
          Math.ceil((n + 1) / (capacity(depth - 1) + 1)),
        ),
        remaining = n - groups + 1,
        base = Math.floor(remaining / groups),
        extra = remaining % groups;
      let at = 0;
      for (let i = 0; i < groups; i++) {
        const size = base + (i < extra ? 1 : 0);
        children.push(
          await make(await slice(b, ps, at, size), size, depth - 1, false),
        );
        at += size;
        if (i < groups - 1) {
          const pair = await slice(b, ps, at++, 1);
          let p = pair[0];
          while (p.kind === "node") p = (await expand<V, M>(b, p))[0];
          check(p.kind === "row", "invalid separator");
          own.push(p);
        }
      }
    }
    const summaryParts: M[] = [];
    for (const p of ps) {
      if (p.kind === "node") summaryParts.push(p.summary);
      else {
        const v = c.entry(p.key, p.value);
        summaryParts.push(isPromiseLike(v) ? await v : v);
      }
    }
    const value = n ? c.combine(summaryParts) : c.empty,
      summary = isPromiseLike(value) ? await value : value;
    const ownRefs = c.edges ? own.flatMap((r) => c.edges!(r.value)) : [],
      inlined = own.length + children.reduce((n, c) => n + c.h.inlined, 0);
    let cut = !!children.length && inlined > 1280,
      refs = ownRefs;
    if (!cut) {
      refs = distinct([
        ...ownRefs,
        ...(await Promise.all(children.map((c) => c.edges()))).flat(),
      ]);
      cut = !!children.length && refs.length > (b.options.maxDegree ?? 320);
    }
    const slots: (Node | Edge)[] = [];
    if (cut) {
      refs = ownRefs.slice();
      for (const child of children) {
        const e = await child.seal();
        slots.push(e);
        refs.push(e);
      }
    } else for (const child of children) slots.push(await child.node());
    refs = distinct(refs);
    const h: BTreeHeader = {
      count: BigInt(n),
      depth,
      inlined: cut ? own.length : inlined,
      keys: n ? [bounds(ps[0])[0], bounds(ps.at(-1)!)[1]] : null,
    };
    const result = built(
      b,
      PATH,
      h,
      [
        c.migration,
        summary,
        own.map((r) => r.key),
        own.map((r) => r.value),
        depth ? slots : null,
      ],
      refs,
    );
    return {
      h,
      summary,
      node: async () => result.node,
      edges: async () => refs,
      seal: memo(() => b.seal(result.node, refs)),
    };
  };
  return (await make(pieces, n, depth, true)).seal();
}
