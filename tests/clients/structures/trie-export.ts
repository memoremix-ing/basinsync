/** Canonical packing of disjoint rows and opaque, reusable stored subtrees. */
import {
  Basin,
  type Edge,
  type Node,
  check,
  compare,
  concat,
  equal,
  object,
  edgeFrom,
  validateNode,
  validateEdge,
  distinct,
  query,
  DOMAIN,
} from "./core";
import { Reference } from "../flexbuffer";
import type { Consumer, Header } from "./trie";
import { summaryReuse } from "./summary";
const PATH = ".trie-node/",
  empty = () => new Uint8Array();
export type Block = { key: Uint8Array; prefix: boolean };
export type Piece<V, M> =
  | { kind: "row"; key: Uint8Array; value: V }
  | {
      kind: "node";
      source: Reference | Edge;
      origin: Uint8Array;
      from: Uint8Array;
      to: Uint8Array;
      h: Header;
      summary: M;
    };
const starts = (k: Uint8Array, p: Uint8Array) =>
  k.length >= p.length && equal(k.subarray(0, p.length), p);
const next = (p: Uint8Array) => {
  const k = p.slice();
  for (let i = k.length - 1; i >= 0; i--)
    if (k[i] < 255) {
      k[i]++;
      return k.slice(0, i + 1);
    }
  return undefined;
};
export function bounds<V, M>(p: Piece<V, M>): [Uint8Array, Uint8Array] {
  if (p.kind === "row") return [p.key, p.key];
  check(p.h.keys, "empty subtree piece");
  return p.h.keys.map((k) =>
    concat([p.to, concat([p.origin, k]).subarray(p.from.length)]),
  ) as [Uint8Array, Uint8Array];
}
export function mapPiece<V, M>(
  p: Piece<V, M>,
  remove: Uint8Array,
  add: Uint8Array,
): Piece<V, M> {
  if (p.kind === "row")
    return { ...p, key: concat([add, p.key.subarray(remove.length)]) };
  return remove.length <= p.to.length
    ? { ...p, to: concat([add, p.to.subarray(remove.length)]) }
    : { ...p, from: concat([p.from, remove.subarray(p.to.length)]), to: add };
}
function nodePiece<V, M>(
  source: Reference | Edge,
  origin: Uint8Array,
  from: Uint8Array = empty(),
  to: Uint8Array = empty(),
): Piece<V, M> {
  if (Array.isArray(source)) {
    validateEdge(source);
    return {
      kind: "node",
      source,
      origin,
      from,
      to,
      h: source[5] as Header,
      summary: source[6][1] as M,
    };
  }
  validateNode(source, PATH);
  return {
    kind: "node",
    source,
    origin,
    from,
    to,
    h: object<Header>(source.get("5")),
    summary: object<M>(source.get("6").get(1)),
  };
}
async function ref(b: Basin, p: Extract<Piece<any, any>, { kind: "node" }>) {
  return Array.isArray(p.source) ? b.load(p.source) : p.source;
}
export async function expand<V, M>(
  b: Basin,
  p: Extract<Piece<V, M>, { kind: "node" }>,
): Promise<Piece<V, M>[]> {
  const r = await ref(b, p);
  validateNode(r, PATH);
  const h = object<Header>(r.get("5")),
    f = r.get("6");
  check(f.length() === 5, "invalid trie footer");
  const here = concat([p.origin, h.prefix ?? empty()]),
    out: Piece<V, M>[] = [];
  const group = (g: Reference) => {
    const ks = g.get("keys"),
      vs = g.get("values");
    check(ks.length() === vs.length() && ks.length() <= 255, "invalid group");
    for (let i = 0; i < ks.length(); i++)
      out.push(
        mapPiece(
          {
            kind: "row",
            key: concat([here, ks.get(i).blobValue()!]),
            value: object<V>(vs.get(i)),
          },
          p.from,
          p.to,
        ),
      );
  };
  group(f.get(2));
  const members = f.get(3),
    edged = f.get(4).boolValue();
  if (!members.isNull())
    for (let high = 0; high < members.length(); high++) {
      const m = members.get(high);
      if (m.isNull()) continue;
      if (m.isMap()) group(m);
      else
        for (let low = 0; low < m.length(); low++) {
          const c = m.get(low);
          if (c.isNull()) continue;
          const source = edged ? edgeFrom(c) : c,
            origin = concat([here, new Uint8Array([(high << 4) | low])]);
          const piece = nodePiece<V, M>(source, origin, p.from, p.to);
          if (piece.kind === "node" && piece.h.count) out.push(piece);
        }
    }
  return out;
}
export async function* sourcePieces<V, M>(
  b: Basin,
  source: Reference | Edge,
  wanted: Uint8Array,
  blocked: readonly Block[],
): AsyncGenerator<Piece<V, M>> {
  if (Array.isArray(source)) b.peek(source);
  async function* walk(
    p: Piece<V, M>,
    depth: number,
  ): AsyncGenerator<Piece<V, M>> {
    check(depth < 256, "trie nesting limit");
    if (p.kind === "node" && !p.h.count) return;
    const [lo, hi] = bounds(p),
      end = next(wanted);
    if (compare(hi, wanted) < 0 || (end && compare(lo, end) >= 0)) return;
    const intersects = (x: Block) =>
      x.prefix
        ? compare(hi, x.key) >= 0 &&
          (!next(x.key) || compare(lo, next(x.key)!) < 0)
        : compare(lo, x.key) <= 0 && compare(hi, x.key) >= 0;
    const covers = (x: Block) =>
      x.prefix
        ? starts(lo, x.key) && starts(hi, x.key)
        : equal(lo, x.key) && equal(hi, x.key);
    if (blocked.some(covers)) return;
    if (starts(lo, wanted) && starts(hi, wanted) && !blocked.some(intersects)) {
      yield p;
      return;
    }
    if (p.kind === "row") {
      yield p;
      return;
    }
    for (const child of await expand<V, M>(b, p)) yield* walk(child, depth + 1);
  }
  yield* walk(nodePiece<V, M>(source, empty()), 0);
}
export type Exported<M> = {
  h: Header;
  summary: M;
  source?: Reference | Edge;
  node?: Node;
  edges?: Edge[];
  materialize(): Promise<{ node: Node; edges: Edge[] }>;
  seal(): Promise<Edge>;
};
export async function buildPieces<V, M>(
  b: Basin,
  pieces: Piece<V, M>[],
  c: Consumer<V, M>,
): Promise<Exported<M>> {
  check(summaryReuse(c), "selective export requires composable summaries");
  const max = b.options.maxDegree ?? 320;
  const group = (
    rs: Extract<Piece<V, M>, { kind: "row" }>[],
    base: Uint8Array,
  ) => ({
    keys: rs.map((r) => r.key.slice(base.length)),
    values: rs.map((r) => r.value),
  });
  const count = (p: Piece<V, M>) => (p.kind === "row" ? 1n : p.h.count);
  async function* rows(
    ps: Piece<V, M>[],
  ): AsyncGenerator<Extract<Piece<V, M>, { kind: "row" }>> {
    for (const p of ps)
      if (p.kind === "row") yield p;
      else yield* rows(await expand<V, M>(b, p));
  }
  async function flatten(ps: Piece<V, M>[]) {
    const rs = [];
    for await (const r of rows(ps)) rs.push(r);
    return rs.sort((a, b) => compare(a.key, b.key));
  }
  function result(
    h: Header,
    summary: M,
    source?: Reference | Edge,
    node?: Node,
    edges?: Edge[],
  ): Exported<M> {
    const out: Exported<M> = {
      h,
      summary,
      source,
      node,
      edges,
      async materialize() {
        if (!out.node) {
          const r = Array.isArray(source) ? await b.load(source) : source!;
          validateNode(r, PATH);
          out.node = object<Node>(r);
          out.edges = await shallowRefs(out.node);
        }
        return { node: out.node!, edges: out.edges! };
      },
      async seal() {
        if (Array.isArray(out.source)) return out.source;
        const { node, edges } = await out.materialize();
        const e = await b.seal(node, edges);
        out.source = e;
        return e;
      },
    };
    return out;
  }
  async function shallowRefs(node: Node): Promise<Edge[]> {
    if (node[3].degree === 0) return [];
    const f = node[6],
      edges: Edge[] = c.edges
        ? (f[2] as { values: V[] }).values.flatMap((v) => c.edges!(v))
        : [];
    for (const m of (f[3] as any[] | null) ?? [])
      if (m) {
        if (Array.isArray(m)) {
          for (const ch of m)
            if (ch)
              edges.push(
                ...(Array.isArray(ch) ? [ch as Edge] : await shallowRefs(ch)),
              );
        } else if (c.edges)
          edges.push(...m.values.flatMap((v: V) => c.edges!(v)));
      }
    return distinct(edges);
  }
  async function partition(
    ps: Piece<V, M>[],
    offset: number,
    shift: number,
  ): Promise<Piece<V, M>[][]> {
    const buckets: Piece<V, M>[][] = Array.from({ length: 16 }, () => []),
      pending = ps.slice();
    while (pending.length) {
      const p = pending.pop()!,
        [lo, hi] = bounds(p);
      if (
        lo.length > offset &&
        hi.length > offset &&
        lo[offset] >> shift === hi[offset] >> shift
      )
        buckets[(lo[offset] >> shift) & 15].push(p);
      else {
        check(p.kind === "node", "partition mismatch");
        pending.push(...(await expand<V, M>(b, p)));
      }
    }
    return buckets;
  }
  async function build(
    ps: Piece<V, M>[],
    base: Uint8Array,
    depth: number,
  ): Promise<Exported<M>> {
    check(depth < 256, "trie nesting limit");
    ps = ps
      .filter((p) => p.kind === "row" || p.h.count > 0n)
      .sort((a, b) => compare(bounds(a)[0], bounds(b)[0]));
    for (let i = 1; i < ps.length; i++)
      check(
        compare(bounds(ps[i - 1])[1], bounds(ps[i])[0]) < 0,
        "overlapping export pieces",
      );
    const validSummary = (p: Extract<Piece<V, M>, { kind: "node" }>) =>
      summaryReuse(c)!.keyIndependent || equal(p.from, p.to);
    if (ps.length === 1 && ps[0].kind === "node") {
      const p = ps[0];
      if (
        validSummary(p) &&
        p.origin.length >= p.from.length &&
        starts(p.origin, p.from) &&
        equal(concat([p.to, p.origin.subarray(p.from.length)]), base)
      )
        return result(p.h, p.summary, p.source);
    }
    // Invalid relocated summaries must be regenerated from entries.
    const normalized: Piece<V, M>[] = [];
    for (const p of ps)
      if (p.kind === "node" && !validSummary(p))
        normalized.push(...(await flatten([p])));
      else normalized.push(p);
    ps = normalized.sort((a, b) => compare(bounds(a)[0], bounds(b)[0]));
    const total = ps.reduce((n, p) => n + count(p), 0n),
      lo = ps.length ? bounds(ps[0])[0] : null,
      hi = ps.length ? bounds(ps.at(-1)!)[1] : null;
    let prefix = base.length;
    if (lo && hi)
      while (
        prefix < lo.length &&
        prefix < hi.length &&
        lo[prefix] === hi[prefix]
      )
        prefix++;
    const here = lo ? lo.slice(0, prefix) : base;
    // Separate a prefix-ending value without expanding unrelated ranges.
    const pending = ps.slice(),
      own: Extract<Piece<V, M>, { kind: "row" }>[] = [],
      rest: Piece<V, M>[] = [];
    if (total <= 255n) own.push(...(await flatten(ps)));
    else
      while (pending.length) {
        const p = pending.shift()!,
          [first] = bounds(p);
        if (first.length === prefix) {
          if (p.kind === "row") own.push(p);
          else pending.unshift(...(await expand<V, M>(b, p)));
        } else rest.push(p);
      }
    const high = total > 255n ? await partition(rest, prefix, 4) : null;
    type Member =
      | { rows: Extract<Piece<V, M>, { kind: "row" }>[] }
      | { children: (Exported<M> | null)[] };
    let members: (Member | null)[] | null = high ? Array(16).fill(null) : null;
    async function split(bucket: Piece<V, M>[], h: number) {
      const low = await partition(bucket, prefix, 0),
        children: (Exported<M> | null)[] = Array(16).fill(null);
      for (let l = 0; l < 16; l++)
        if (low[l].length)
          children[l] = await build(
            low[l],
            concat([here, new Uint8Array([(h << 4) | l])]),
            depth + 1,
          );
      return { children };
    }
    if (high)
      for (let h = 0; h < 16; h++)
        if (high[h].length)
          members![h] =
            high[h].reduce((n, p) => n + count(p), 0n) <= 255n
              ? { rows: await flatten(high[h]) }
              : await split(high[h], h);
    const refsOfRows = (rs: typeof own) =>
      c.edges ? rs.flatMap((r) => c.edges!(r.value)) : [];
    const ownRefs = refsOfRows(own);
    const inlined = () =>
      own.length +
      (members ?? []).reduce(
        (n, m) =>
          n +
          (!m
            ? 0
            : "rows" in m
              ? m.rows.length
              : m.children.reduce((s, t) => s + (t?.h.inlined ?? 0), 0)),
        0,
      );
    const inlineRefs = async () => {
      const refs = [...ownRefs];
      for (const m of members ?? [])
        if (m) {
          if ("rows" in m) refs.push(...refsOfRows(m.rows));
          else
            for (const ch of m.children)
              if (ch) {
                if (
                  ch.source &&
                  (Array.isArray(ch.source)
                    ? ch.source[3].degree
                    : ch.source.get("3").get("degree").intValue()) === 0
                )
                  continue;
                refs.push(...(await ch.materialize()).edges);
              }
        }
      return distinct(refs);
    };
    const allRefs = await inlineRefs(),
      degreeCut = allRefs.length > max,
      cut = !!members && (inlined() > 1280 || degreeCut);
    if (degreeCut && members && high)
      for (let h = 0; h < members.length; h++)
        if (members[h] && "rows" in members[h]!)
          members[h] = await split(high[h], h);
    const edges = [...ownRefs],
      encoded: any[] | null = members ? Array(16).fill(null) : null;
    if (members)
      for (let h = 0; h < 16; h++) {
        const m = members[h];
        if (!m) continue;
        if ("rows" in m) {
          encoded![h] = group(m.rows, here);
          edges.push(...refsOfRows(m.rows));
        } else {
          const low: any[] = Array(16).fill(null);
          for (let l = 0; l < 16; l++) {
            const child = m.children[l];
            if (!child) continue;
            if (cut) {
              const e = await child.seal();
              low[l] = e;
              edges.push(e);
            } else {
              const built = await child.materialize();
              low[l] = built.node;
              edges.push(...built.edges);
            }
          }
          while (low.length && low.at(-1) === null) low.pop();
          encoded![h] = low;
        }
      }
    if (encoded)
      while (encoded.length && encoded.at(-1) === null) encoded.pop();
    const summaries: M[] = [];
    for (const p of ps)
      summaries.push(
        p.kind === "node" ? p.summary : await c.entry(p.key, p.value),
      );
    const summary = total ? await c.combine(summaries) : c.empty;
    let nullity = 0n,
      min = Infinity,
      maxLen = 0;
    for (const p of ps) {
      if (p.kind === "row") {
        if (p.value === null) nullity++;
        min = Math.min(min, p.key.length - base.length);
        maxLen = Math.max(maxLen, p.key.length - base.length);
      } else {
        nullity += p.h.nullity;
        const delta =
          p.to.length + p.origin.length - p.from.length - base.length;
        if (p.h.lengths) {
          min = Math.min(min, p.h.lengths[0] + delta);
          maxLen = Math.max(maxLen, p.h.lengths[1] + delta);
        }
      }
    }
    const h: Header = {
      count: total,
      nullity,
      prefix: here.length > base.length ? here.slice(base.length) : null,
      keys: lo ? [lo.slice(base.length), hi!.slice(base.length)] : null,
      lengths: total ? [min, maxLen] : null,
      inlined:
        own.length +
        (members ?? []).reduce(
          (n, m) =>
            n +
            (!m
              ? 0
              : "rows" in m
                ? m.rows.length
                : cut
                  ? 0
                  : m.children.reduce((s, t) => s + (t?.h.inlined ?? 0), 0)),
          0,
        ),
      degree: (members ?? []).reduce(
        (n, m) =>
          n + (!m ? 0 : "rows" in m ? 1 : m.children.filter(Boolean).length),
        0,
      ),
    };
    const refs = distinct(edges),
      node = {
        0: Symbol.species,
        1: DOMAIN,
        2: PATH,
        3: query(refs, max, b.options.maxHeight ?? 128),
        4: 0,
        5: h,
        6: [
          c.migration,
          summary,
          group(own, here),
          encoded,
          members ? cut : null,
        ],
      } as Node;
    return result(h, summary, undefined, node, refs);
  }
  return build(pieces, empty(), 0);
}
