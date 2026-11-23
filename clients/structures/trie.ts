import { TrieMap } from "./logical-trie";
import { type Operation, resolveOperation } from "./operation";
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
  isPromiseLike,
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
type LookupGroup = { keys: Uint8Array[]; values: Reference };
type LookupChild = { ref: Reference } | { edge: Edge; header: Header };
type LookupPlan = {
  header: Header;
  group: LookupGroup;
  members: Reference;
  edged: boolean | null;
  groups: Map<number, LookupGroup>;
  children: Map<number, LookupChild | null>;
};
function lookupGroup(g: Reference): LookupGroup {
  const keys = g.get("keys"),
    values = g.get("values");
  check(
    g.isMap() && keys.length() === values.length() && keys.length() <= 255,
    "invalid trie group",
  );
  const blobs: Uint8Array[] = [];
  for (let i = 0; i < keys.length(); i++) {
    const b = keys.get(i).blobValue();
    check(b, "invalid key blob");
    blobs.push(b);
  }
  return { keys: blobs, values };
}
/** Compare a stored suffix against a position in the caller's owned key. */
function compareSuffix(a: Uint8Array, raw: Uint8Array, offset: number): number {
  const remaining = raw.length - offset,
    length = Math.min(a.length, remaining);
  for (let i = 0; i < length; i++) {
    const difference = a[i] - raw[offset + i];
    if (difference) return difference;
  }
  return a.length - remaining;
}
function findValue(
  group: LookupGroup,
  key: Uint8Array,
  offset: number,
): Reference | undefined {
  let lo = 0,
    hi = group.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareSuffix(group.keys[mid], key, offset) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo < group.keys.length &&
    compareSuffix(group.keys[lo], key, offset) === 0
    ? group.values.get(lo)
    : undefined;
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
      const summary = c.entry(k, value);
      rows.push({
        key: k,
        full: k,
        value,
        summary: isPromiseLike(summary) ? await summary : summary,
      });
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
      // Stable partitions preserve sorting: the endpoints determine the common prefix.
      let prefixLength = 0;
      if (input.length) {
        const first = input[0].key,
          last = input[input.length - 1].key;
        const limit = Math.min(first.length, last.length);
        while (
          prefixLength < limit &&
          first[prefixLength] === last[prefixLength]
        )
          prefixLength++;
      }
      const prefix = prefixLength ? input[0].key.slice(0, prefixLength) : null,
        rows = input.map((r) => ({ ...r, key: r.key.slice(prefixLength) }));
      const h: Header = {
        count: BigInt(input.length),
        nullity: BigInt(input.filter((r) => r.value === null).length),
        degree: 0,
        inlined: 0,
        prefix,
        keys: input.length ? [input[0].key, input[input.length - 1].key] : null,
        lengths: bounds(
          input.map((r) => r.key.length),
          (a, b) => a - b,
        ),
      };
      const combined = input.length
        ? c.combine(input.map((r) => r.summary))
        : c.empty;
      const summary = isPromiseLike(combined) ? await combined : combined;
      let own = rows,
        members: (TrieGroup<V> | (Local<V, M> | null)[] | null)[] | null = null,
        edged: boolean | null = null;
      const split = async (bucket: Row<V, M>[]) => {
        const low: (Local<V, M> | null)[] = Array(16).fill(null);
        const parts: Row<V, M>[][] = Array.from({ length: 16 }, () => []);
        for (const row of bucket) parts[row.key[0] & 15].push(row);
        for (let n = 0; n < 16; n++) {
          const part = parts[n];
          if (part.length)
            low[n] = await build(
              part.map((r) => ({ ...r, key: r.key.slice(1) })),
              depth + 1,
            );
        }
        return trim(low);
      };
      let highBuckets: Row<V, M>[][] | undefined;
      if (rows.length > 255) {
        own = rows.filter((r) => r.key.length === 0);
        members = Array(16).fill(null);
        highBuckets = Array.from({ length: 16 }, () => []);
        for (const row of rows)
          if (row.key.length) highBuckets[row.key[0] >> 4].push(row);
        for (let high = 0; high < 16; high++) {
          const bucket = highBuckets[high];
          if (bucket.length)
            members[high] =
              bucket.length <= 255 ? group(bucket) : await split(bucket);
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
              members[high] = await split(highBuckets![high]);
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
        g.get("keys").length() <= 255,
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
  private readonly lookups = new WeakMap<Reference, LookupPlan>();
  private lookupPlan(r: Reference): LookupPlan {
    let p = this.lookups.get(r);
    if (!p) {
      const raw = this.parts(r);
      p = {
        header: raw.header,
        group: lookupGroup(raw.group),
        members: raw.members,
        edged: raw.edged,
        groups: new Map(),
        children: new Map(),
      };
      this.lookups.set(r, p);
    }
    return p;
  }
  private lookupChild(
    p: LookupPlan,
    byte: number,
  ): LookupChild | LookupGroup | null {
    const high = byte >> 4;
    if (p.members.isNull() || high >= p.members.length()) return null;
    const known = p.groups.get(high);
    if (known) return known;
    if (p.children.has(byte)) return p.children.get(byte)!;
    const m = p.members.get(high);
    if (m.isNull()) {
      p.children.set(byte, null);
      return null;
    }
    if (m.isMap()) {
      const g = lookupGroup(m);
      p.groups.set(high, g);
      return g;
    }
    check(m.isVector() && m.length() <= 16, "invalid nibble slots");
    const low = byte & 15;
    let result: LookupChild | null = null;
    if (low < m.length()) {
      const child = m.get(low);
      if (!child.isNull()) {
        if (p.edged) {
          const edge = edgeFrom(child);
          result = { edge, header: edge[5] as Header };
        } else result = { ref: child };
      }
    }
    p.children.set(byte, result);
    return result;
  }
  /** Does no I/O until a returned generator is resumed; ready reads allocate no Promise. */
  getViewOrDefer(raw: Uint8Array | string): Operation<Reference | undefined> {
    const k = key(raw),
      [header] = this.rootInfo();
    if (
      !header.keys ||
      compare(k, header.keys[0]) < 0 ||
      compare(k, header.keys[1]) > 0
    )
      return undefined;
    if (!Array.isArray(this.source)) return this.seek(this.source, k, 0);
    const r = this.basin.peek(this.source);
    return r
      ? this.seek(r, k, 0)
      : () => this.resumeLookup(this.source as Edge, k, 0);
  }
  private *resumeLookup(
    edge: Edge,
    k: Uint8Array,
    depth: number,
    offset = 0,
  ): Generator<PromiseLike<unknown>, Reference | undefined, unknown> {
    const r = (yield this.basin.load(edge)) as Reference;
    const next = this.seek(r, k, depth, offset);
    return typeof next === "function" ? yield* next() : next;
  }
  private seek(
    r: Reference,
    k: Uint8Array,
    depth: number,
    offset = 0,
  ): Operation<Reference | undefined> {
    for (;;) {
      check(depth++ < 256, "trie nesting limit");
      const p = this.lookupPlan(r),
        prefix = p.header.prefix;
      if (prefix) {
        if (k.length - offset < prefix.length) return undefined;
        for (let i = 0; i < prefix.length; i++)
          if (prefix[i] !== k[offset + i]) return undefined;
        offset += prefix.length;
      }
      const own = findValue(p.group, k, offset);
      if (own !== undefined) return own;
      if (offset === k.length) return undefined;
      const child = this.lookupChild(p, k[offset]);
      if (!child) return undefined;
      if ("keys" in child) return findValue(child, k, offset);
      offset++;
      if ("edge" in child) {
        const h = child.header;
        if (
          !h.keys ||
          compareSuffix(h.keys[0], k, offset) > 0 ||
          compareSuffix(h.keys[1], k, offset) < 0
        )
          return undefined;
        const cached = this.basin.peek(child.edge);
        if (!cached)
          return () => this.resumeLookup(child.edge, k, depth, offset);
        r = cached;
      } else r = child.ref;
    }
  }
  getOrDefer(raw: Uint8Array | string): Operation<V | undefined> {
    const r = this.getViewOrDefer(raw);
    if (typeof r === "function")
      return function* () {
        const value = yield* r();
        return value === undefined ? undefined : object<V>(value);
      };
    return r === undefined ? undefined : object<V>(r);
  }
  async getView(raw: Uint8Array | string): Promise<Reference | undefined> {
    return resolveOperation(this.getViewOrDefer(raw));
  }
  async get(raw: Uint8Array | string): Promise<V | undefined> {
    const op = this.getOrDefer(raw);
    return typeof op === "function" ? resolveOperation(op) : op;
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
          ks.length() === vs.length() && ks.length() <= 255,
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
  /** Load once for synchronous path-copied edits; store explicitly after a batch. */
  async edit(): Promise<TrieEditor<V, M>> {
    const rows: [Uint8Array, V][] = [];
    for await (const row of this.entries()) rows.push(row);
    return TrieEditor.from(this.basin, rows, this.consumer);
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

/** Immutable logical snapshots. Canonical export is a separate, full packing pass. */
export class TrieEditor<V, M = null> {
  private constructor(
    readonly basin: Basin,
    private readonly values: TrieMap<V>,
    readonly consumer: Consumer<V, M>,
  ) {}
  static from<V, M>(
    basin: Basin,
    input: Iterable<readonly [Uint8Array | string, V]>,
    consumer: Consumer<V, M>,
  ): TrieEditor<V, M> {
    return new TrieEditor(basin, TrieMap.from(input), consumer);
  }
  get size() {
    return this.values.size;
  }
  get(k: Uint8Array | string) {
    return this.values.get(k);
  }
  has(k: Uint8Array | string) {
    return this.values.has(k);
  }
  set(k: Uint8Array | string, v: V): TrieEditor<V, M> {
    const next = this.values.set(k, v);
    return next === this.values
      ? this
      : new TrieEditor(this.basin, next, this.consumer);
  }
  delete(k: Uint8Array | string): TrieEditor<V, M> {
    const next = this.values.delete(k);
    return next === this.values
      ? this
      : new TrieEditor(this.basin, next, this.consumer);
  }
  entries() {
    return this.values.entries();
  }
  store(): Promise<Trie<V, M>> {
    return Trie.build(this.basin, this.entries(), this.consumer);
  }
}
