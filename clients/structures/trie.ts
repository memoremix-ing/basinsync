import { Reference } from "../flexbuffer";
import {
  Basin,
  Edge,
  Node,
  DOMAIN,
  check,
  key,
  compare,
  equal,
  concat,
  object,
  validateNode,
  edgeFrom,
  query,
  distinct,
  u32,
} from "./core";
import type { TrieNode_S0, TrieGroup, Bounds } from "./types";
export const TRIE = ".trie-node/";
export type TrieNode<V, M> = TrieNode_S0<{
  [migration: number]: { Summary: M; Value: V };
}>;
export type Header = TrieNode<unknown, unknown>[5];
export interface Consumer<V, M> {
  migration: number;
  empty: M;
  entry(key: Uint8Array, value: V): M | Promise<M>;
  combine(summaries: readonly M[]): M | Promise<M>;
  edges?(value: V): Edge[];
}
export const plain: Consumer<unknown, null> = {
  migration: 0,
  empty: null,
  entry: () => null,
  combine: () => null,
};
type Row<V, M> = { key: Uint8Array; full: Uint8Array; value: V; summary: M };
type Local<V, M> = TrieNode<V, M> | Edge;
export const starts = (k: Uint8Array, p: Uint8Array) =>
  k.length >= p.length && equal(k.subarray(0, p.length), p);
const group = <V, M>(rows: Row<V, M>[]): TrieGroup<V> => ({
  keys: rows.map((r) => r.key),
  values: rows.map((r) => r.value),
});
function trim<T>(a: (T | null)[]): (T | null)[] {
  while (a.length && a[a.length - 1] === null) a.pop();
  return a;
}
function bounds<T>(items: T[], cmp: (a: T, b: T) => number): Bounds<T> {
  if (!items.length) return null;
  let lo = items[0],
    hi = items[0];
  for (const v of items) {
    if (cmp(v, lo) < 0) lo = v;
    if (cmp(v, hi) > 0) hi = v;
  }
  return [lo, hi];
}
function nextPrefix(p: Uint8Array): Uint8Array | undefined {
  const n = p.slice();
  for (let i = n.length - 1; i >= 0; i--)
    if (n[i] < 255) {
      n[i]++;
      return n.slice(0, i + 1);
    }
  return undefined;
}
function intersects(base: Uint8Array, h: Header, p: Uint8Array): boolean {
  if (!h.keys) return false;
  const lo = concat([base, h.keys[0]]),
    hi = concat([base, h.keys[1]]),
    end = nextPrefix(p);
  return compare(hi, p) >= 0 && (!end || compare(lo, end) < 0);
}
/** Sorted key groups and two indexed nibble levels. Writes never depend on insertion history. */
export class Trie<V = unknown, M = null> {
  constructor(
    readonly basin: Basin,
    private source: Edge | Reference,
    readonly consumer: Consumer<V, M>,
  ) {
    if (Array.isArray(source))
      check(
        source[1] === DOMAIN &&
          source[2] === TRIE &&
          source[6][0] === consumer.migration,
        "unsupported trie migration",
      );
    else {
      validateNode(source, TRIE);
      check(
        source.get("6").get(0).intValue() === consumer.migration,
        "unsupported trie migration",
      );
    }
  }
  get root(): Edge {
    check(Array.isArray(this.source), "inline trie has no standalone root");
    return this.source;
  }
  private readRoot(): Promise<Reference> {
    return Array.isArray(this.source)
      ? this.basin.load(this.source)
      : Promise.resolve(this.source);
  }
  private rootInfo(): [Header, M] {
    return Array.isArray(this.source)
      ? [this.source[5] as Header, this.source[6][1] as M]
      : [
          object<Header>(this.source.get("5")),
          object<M>(this.source.get("6").get(1)),
        ];
  }
  static async build<V, M>(
    basin: Basin,
    input: Iterable<[Uint8Array | string, V]>,
    c: Consumer<V, M>,
  ): Promise<Trie<V, M>> {
    const { node, edges } = await Trie.buildNode(basin, input, c);
    return new Trie(basin, await basin.seal(node, edges), c);
  }
  static async buildNode<V, M>(
    basin: Basin,
    input: Iterable<[Uint8Array | string, V]>,
    c: Consumer<V, M>,
  ): Promise<{ node: TrieNode<V, M>; edges: Edge[] }> {
    u32(c.migration);
    const rows: Row<V, M>[] = [];
    for (const [raw, value] of input) {
      const k = key(raw);
      rows.push({ key: k, full: k, value, summary: await c.entry(k, value) });
    }
    rows.sort((a, b) => compare(a.key, b.key));
    for (let i = 1; i < rows.length; i++)
      check(!equal(rows[i - 1].key, rows[i].key), "duplicate trie key");
    const outgoing = new WeakMap<object, Edge[]>();
    const build = async (
      input: Row<V, M>[],
      depth = 0,
    ): Promise<TrieNode<V, M>> => {
      check(depth < 256, "trie nesting limit");
      let prefixLength = input.length ? input[0].key.length : 0;
      for (const r of input) {
        prefixLength = Math.min(prefixLength, r.key.length);
        for (let i = 0; i < prefixLength; i++)
          if (r.key[i] !== input[0].key[i]) {
            prefixLength = i;
            break;
          }
      }
      const prefix = prefixLength ? input[0].key.slice(0, prefixLength) : null,
        rows = input.map((r) => ({ ...r, key: r.key.slice(prefixLength) }));
      const h: Header = {
        count: BigInt(input.length),
        nullity: BigInt(input.filter((r) => r.value === null).length),
        degree: 0,
        inlined: 0,
        prefix,
        keys: bounds(
          input.map((r) => r.key),
          compare,
        ),
        reversals: bounds(
          input.map((r) => r.key.slice().reverse()),
          compare,
        ),
        lengths: bounds(
          input.map((r) => r.key.length),
          (a, b) => a - b,
        ),
      };
      const summary = input.length
        ? await c.combine(input.map((r) => r.summary))
        : c.empty;
      let own = rows,
        members: (TrieGroup<V> | (Local<V, M> | null)[] | null)[] | null = null,
        edged: boolean | null = null;
      const split = async (bucket: Row<V, M>[]) => {
        const low: (Local<V, M> | null)[] = Array(16).fill(null);
        for (let n = 0; n < 16; n++) {
          const part = bucket.filter((r) => (r.key[0] & 15) === n);
          if (part.length)
            low[n] = await build(
              part.map((r) => ({ ...r, key: r.key.slice(1) })),
              depth + 1,
            );
        }
        return trim(low);
      };
      if (rows.length > 63) {
        own = rows.filter((r) => r.key.length === 0);
        members = Array(16).fill(null);
        for (let high = 0; high < 16; high++) {
          const bucket = rows.filter(
            (r) => r.key.length > 0 && r.key[0] >> 4 === high,
          );
          if (bucket.length)
            members[high] =
              bucket.length <= 63 ? group(bucket) : await split(bucket);
        }
        members = trim(members);
        edged = false;
      }
      const refs = () => {
        const result = c.edges ? own.flatMap((r) => c.edges!(r.value)) : [];
        if (members)
          for (const m of members)
            if (m) {
              if (Array.isArray(m)) {
                for (const n of m)
                  if (n)
                    result.push(...(Array.isArray(n) ? [n] : outgoing.get(n)!));
              } else if (c.edges)
                for (const v of m.values) result.push(...c.edges(v));
            }
        return distinct(result);
      };
      const inlineCount = () =>
        own.length +
        (members ?? []).reduce(
          (n, m) =>
            n +
            (!m
              ? 0
              : Array.isArray(m)
                ? m.reduce(
                    (s, t) => s + (!t || Array.isArray(t) ? 0 : t[5].inlined),
                    0,
                  )
                : m.keys.length),
          0,
        );
      if (
        members &&
        (inlineCount() > 1280 ||
          refs().length > (basin.options.maxDegree ?? 320))
      ) {
        // Value edges can fill small high-nibble groups too. Turn those groups into
        // low-nibble nodes before externalizing, so physical degree stays bounded.
        if (refs().length > (basin.options.maxDegree ?? 320))
          for (let high = 0; high < members.length; high++) {
            const m = members[high];
            if (m && !Array.isArray(m))
              members[high] = await split(
                rows.filter((r) => r.key.length > 0 && r.key[0] >> 4 === high),
              );
          }
        for (const m of members)
          if (Array.isArray(m))
            for (let n = 0; n < m.length; n++) {
              const child = m[n];
              if (child && !Array.isArray(child))
                m[n] = await basin.seal(child, outgoing.get(child)!);
            }
        edged = true;
      }
      h.inlined = inlineCount();
      h.degree = (members ?? []).reduce(
        (n, m) =>
          n + (!m ? 0 : Array.isArray(m) ? m.filter(Boolean).length : 1),
        0,
      );
      const node = {
        0: Symbol.species,
        1: DOMAIN,
        2: TRIE,
        3: query(
          refs(),
          basin.options.maxDegree ?? 320,
          basin.options.maxHeight ?? 128,
        ),
        4: 0,
        5: h,
        6: [c.migration, summary, group(own), members, edged],
      } as TrieNode<V, M>;
      outgoing.set(node, refs());
      return node;
    };
    const node = await build(rows);
    return { node, edges: outgoing.get(node)! };
  }
  private parts(r: Reference): {
    header: Header;
    footer: Reference;
    group: Reference;
    members: Reference;
    edged: boolean | null;
  } {
    validateNode(r, TRIE);
    const f = r.get("6");
    check(
      f.length() === 5 && f.get(0).intValue() === this.consumer.migration,
      "unsupported trie migration",
    );
    const h = object<Header>(r.get("5"));
    check(typeof h.count === "bigint" && h.count >= 0n, "invalid trie count");
    const g = f.get(2);
    check(
      g.isMap() &&
        g.get("keys").length() === g.get("values").length() &&
        g.get("keys").length() <= 63,
      "invalid trie group",
    );
    const m = f.get(3),
      e = object<boolean | null>(f.get(4));
    check(
      (m.isNull() && e === null) ||
        (!m.isNull() &&
          m.isVector() &&
          m.length() <= 16 &&
          typeof e === "boolean"),
      "invalid trie nesting",
    );
    return { header: h, footer: f, group: g, members: m, edged: e };
  }
  async getView(raw: Uint8Array | string): Promise<Reference | undefined> {
    let k = key(raw);
    const [header] = this.rootInfo();
    if (
      !header.keys ||
      compare(k, header.keys[0]) < 0 ||
      compare(k, header.keys[1]) > 0
    )
      return undefined;
    let r = await this.readRoot();
    for (let depth = 0; ; depth++) {
      check(depth < 256, "trie nesting limit");
      const p = this.parts(r),
        prefix = p.header.prefix ?? new Uint8Array();
      if (!starts(k, prefix)) return undefined;
      k = k.subarray(prefix.length);
      const keys = p.group.get("keys");
      let lo = 0,
        hi = keys.length();
      while (lo < hi) {
        const mid = (lo + hi) >> 1,
          at = keys.get(mid).blobValue();
        check(at, "invalid key blob");
        if (compare(at, k) < 0) lo = mid + 1;
        else hi = mid;
      }
      if (lo < keys.length() && equal(keys.get(lo).blobValue()!, k))
        return p.group.get("values").get(lo);
      if (!k.length || p.members.isNull() || k[0] >> 4 >= p.members.length())
        return undefined;
      const m = p.members.get(k[0] >> 4);
      if (m.isNull()) return undefined;
      if (m.isMap()) {
        const ks = m.get("keys"),
          vs = m.get("values");
        check(
          ks.length() === vs.length() && ks.length() <= 63,
          "invalid child group",
        );
        let a = 0,
          b = ks.length();
        while (a < b) {
          const mid = (a + b) >> 1;
          if (compare(ks.get(mid).blobValue()!, k) < 0) a = mid + 1;
          else b = mid;
        }
        return a < ks.length() && equal(ks.get(a).blobValue()!, k)
          ? vs.get(a)
          : undefined;
      }
      check(m.isVector() && m.length() <= 16, "invalid nibble slots");
      const low = k[0] & 15;
      if (low >= m.length() || m.get(low).isNull()) return undefined;
      const next = m.get(low);
      k = k.subarray(1);
      if (p.edged) {
        const edge = edgeFrom(next);
        const h = edge[5] as Header;
        if (!h.keys || compare(k, h.keys[0]) < 0 || compare(k, h.keys[1]) > 0)
          return undefined;
        r = await this.basin.load(edge);
      } else r = next;
    }
  }
  async get(raw: Uint8Array | string): Promise<V | undefined> {
    const r = await this.getView(raw);
    return r === undefined ? undefined : object<V>(r);
  }
  async *entries(
    prefix: Uint8Array | string = new Uint8Array(),
    accept?: (header: Header, summary: M) => boolean,
  ): AsyncGenerator<[Uint8Array, V]> {
    const wanted = key(prefix),
      self = this;
    async function* walk(
      r: Reference,
      base: Uint8Array,
      depth = 0,
    ): AsyncGenerator<[Uint8Array, V]> {
      check(depth < 256, "trie nesting limit");
      const p = self.parts(r);
      if (
        !intersects(base, p.header, wanted) ||
        (accept && !accept(p.header, object<M>(p.footer.get(1))))
      )
        return;
      const here = concat([base, p.header.prefix ?? new Uint8Array()]);
      const emit = function* (g: Reference) {
        const ks = g.get("keys"),
          vs = g.get("values");
        check(
          ks.length() === vs.length() && ks.length() <= 63,
          "invalid group",
        );
        for (let i = 0; i < ks.length(); i++) {
          const k = concat([here, ks.get(i).blobValue()!]);
          if (starts(k, wanted))
            yield [k, object<V>(vs.get(i))] as [Uint8Array, V];
        }
      };
      yield* emit(p.group);
      if (!p.members.isNull())
        for (let high = 0; high < p.members.length(); high++) {
          const m = p.members.get(high);
          if (m.isNull()) continue;
          if (m.isMap()) {
            yield* emit(m);
            continue;
          }
          check(m.isVector() && m.length() <= 16, "invalid nibble slots");
          for (let low = 0; low < m.length(); low++) {
            const child = m.get(low);
            if (child.isNull()) continue;
            const b = concat([here, new Uint8Array([(high << 4) | low])]);
            if (p.edged) {
              const edge = edgeFrom(child),
                h = edge[5] as Header;
              if (
                intersects(b, h, wanted) &&
                (!accept || accept(h, edge[6][1] as M))
              )
                yield* walk(await self.basin.load(edge), b, depth + 1);
            } else yield* walk(child, b, depth + 1);
          }
        }
    }
    const [header, summary] = this.rootInfo();
    if (
      intersects(new Uint8Array(), header, wanted) &&
      (!accept || accept(header, summary))
    )
      yield* walk(await this.readRoot(), new Uint8Array());
  }
  /** Full canonical rebuild, reusing immutable objects through the storage adapter. */
  async update(
    changes: Iterable<[Uint8Array | string, { set: V } | { delete: true }]>,
  ): Promise<Trie<V, M>> {
    const values = new Map<string, V>();
    for await (const [k, v] of this.entries())
      values.set(
        Array.from(k, (b) => b.toString(16).padStart(2, "0")).join(""),
        v,
      );
    for (const [k, change] of changes) {
      const s = Array.from(key(k), (b) => b.toString(16).padStart(2, "0")).join(
        "",
      );
      if ("delete" in change) values.delete(s);
      else values.set(s, change.set);
    }
    return Trie.build(this.basin, values, this.consumer);
  }
}
