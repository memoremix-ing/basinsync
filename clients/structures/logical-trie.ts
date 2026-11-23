/** Immutable client-side edits. Values are borrowed; keys and structure stay owned. */
import { check, compare, key } from "./core";
type Row<V> = readonly [Uint8Array, V];
type Leaf<V> = {
  kind: 0;
  rows: readonly Row<V>[];
  count: number;
  levels: number;
};
type Branch<V> = {
  kind: 1;
  prefix: Uint8Array;
  own?: Row<V>;
  children: readonly (readonly [number, Tree<V>])[];
  count: number;
  levels: number;
};
type Tree<V> = Leaf<V> | Branch<V>;
const CAP = 255;
function lower<T>(a: readonly T[], cmp: (v: T) => number) {
  let lo = 0,
    hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(a[mid]) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function* rows<V>(n: Tree<V>): Generator<Row<V>> {
  if (n.kind === 0) yield* n.rows;
  else {
    if (n.own) yield n.own;
    for (const [, c] of n.children) yield* rows(c);
  }
}
function leaf<V>(rs: readonly Row<V>[]): Leaf<V> {
  return { kind: 0, rows: rs, count: rs.length, levels: 1 };
}
function prefixLength(a: Uint8Array, b: Uint8Array, start = 0) {
  let i = start;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return i;
}
function compareFrom(a: Uint8Array, b: Uint8Array, offset: number) {
  const end = Math.min(a.length, b.length);
  for (let i = offset; i < end; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function build<V>(rs: readonly Row<V>[], depth = 0): Tree<V> {
  check(depth < 256, "trie nesting limit");
  if (rs.length <= CAP) return leaf(rs);
  const at = prefixLength(rs[0][0], rs[rs.length - 1][0]);
  const own = rs[0][0].length === at ? rs[0] : undefined;
  const children: [number, Tree<V>][] = [];
  for (let lo = own ? 1 : 0; lo < rs.length;) {
    let hi = lo + 1;
    const byte = rs[lo][0][at];
    while (hi < rs.length && rs[hi][0][at] === byte) hi++;
    children.push([byte, build(rs.slice(lo, hi), depth + 1)]);
    lo = hi;
  }
  return {
    kind: 1,
    prefix: rs[0][0].slice(0, at),
    own,
    children,
    count: rs.length,
    levels: 1 + Math.max(...children.map(([, c]) => c.levels)),
  };
}
function branch<V>(
  prefix: Uint8Array,
  own: Row<V> | undefined,
  children: readonly (readonly [number, Tree<V>])[],
): Tree<V> {
  const count = (own ? 1 : 0) + children.reduce((s, [, c]) => s + c.count, 0);
  const levels = 1 + Math.max(0, ...children.map(([, c]) => c.levels));
  const n: Branch<V> = { kind: 1, prefix, own, children, count, levels };
  if (count <= CAP) return leaf([...rows(n)]);
  if (!own && children.length === 1) return children[0][1];
  check(levels <= 256, "trie nesting limit");
  return n;
}
function edit<V>(
  n: Tree<V>,
  k: Uint8Array,
  value: V | undefined,
  remove: boolean,
  offset = 0,
): Tree<V> {
  if (n.kind === 0) {
    const at = lower(n.rows, (r) => compareFrom(r[0], k, offset)),
      exists =
        at < n.rows.length && compareFrom(n.rows[at][0], k, offset) === 0;
    if (
      (remove && !exists) ||
      (exists && !remove && Object.is(n.rows[at][1], value))
    )
      return n;
    const next = n.rows.slice();
    if (remove) next.splice(at, 1);
    else next.splice(at, exists ? 1 : 0, [k, value as V]);
    return build(next);
  }
  const common = prefixLength(n.prefix, k, offset);
  if (common < n.prefix.length) {
    if (remove) return n;
    const own = k.length === common ? ([k, value as V] as const) : undefined;
    const children: [number, Tree<V>][] = [[n.prefix[common], n]];
    if (!own) children.push([k[common], leaf([[k, value as V]])]);
    children.sort((a, b) => a[0] - b[0]);
    return branch(k.slice(0, common), own, children);
  }
  if (k.length === n.prefix.length) {
    if ((remove && !n.own) || (n.own && !remove && Object.is(n.own[1], value)))
      return n;
    return branch(n.prefix, remove ? undefined : [k, value as V], n.children);
  }
  const byte = k[n.prefix.length],
    at = lower(n.children, ([b]) => b - byte),
    exists = at < n.children.length && n.children[at][0] === byte;
  if (!exists && remove) return n;
  const prior = exists ? n.children[at][1] : leaf<V>([]),
    child = edit(prior, k, value, remove, n.prefix.length + 1);
  if (prior === child) return n;
  const children = n.children.slice();
  if (!child.count) children.splice(at, 1);
  else children.splice(at, exists ? 1 : 0, [byte, child]);
  return branch(n.prefix, n.own, children);
}
/** A compressed byte trie; each edit copies a path and at most 255 leaf entries. */
export class TrieMap<V> {
  private constructor(private readonly tree: Tree<V>) {}
  static from<V>(
    input: Iterable<readonly [Uint8Array | string, V]>,
  ): TrieMap<V> {
    const rs: Row<V>[] = [];
    for (const [raw, v] of input) rs.push([key(raw), v]);
    rs.sort((a, b) => compare(a[0], b[0]));
    for (let i = 1; i < rs.length; i++)
      check(compare(rs[i - 1][0], rs[i][0]) !== 0, "duplicate trie key");
    return new TrieMap(build(rs));
  }
  get size() {
    return this.tree.count;
  }
  private find(raw: Uint8Array | string): Row<V> | undefined {
    const k = key(raw);
    let n = this.tree,
      offset = 0;
    for (let depth = 0; depth < 256; depth++) {
      if (n.kind === 0) {
        const at = lower(n.rows, (r) => compareFrom(r[0], k, offset));
        return at < n.rows.length && compareFrom(n.rows[at][0], k, offset) === 0
          ? n.rows[at]
          : undefined;
      }
      if (prefixLength(n.prefix, k, offset) !== n.prefix.length) return;
      if (k.length === n.prefix.length) return n.own;
      const byte = k[n.prefix.length],
        at = lower(n.children, ([b]) => b - byte);
      if (at === n.children.length || n.children[at][0] !== byte) return;
      offset = n.prefix.length + 1;
      n = n.children[at][1];
    }
    throw Error("trie nesting limit");
  }
  get(k: Uint8Array | string): V | undefined {
    return this.find(k)?.[1];
  }
  has(k: Uint8Array | string): boolean {
    return this.find(k) !== undefined;
  }
  set(raw: Uint8Array | string, value: V): TrieMap<V> {
    const next = edit(this.tree, key(raw), value, false);
    return next === this.tree ? this : new TrieMap(next);
  }
  delete(raw: Uint8Array | string): TrieMap<V> {
    const next = edit(this.tree, key(raw), undefined, true);
    return next === this.tree ? this : new TrieMap(next);
  }
  *entries(): Generator<[Uint8Array, V]> {
    for (const [k, v] of rows(this.tree)) yield [k.slice(), v];
  }
}
