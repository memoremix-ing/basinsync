/** Immutable, relocatable logical trie. Values are borrowed; keys and structure stay owned. */
import { check, compare, concat, key } from "./core";
type Row<V> = readonly [Uint8Array, V];
type Leaf<V> = {
  kind: 0;
  owner?: symbol;
  rows: readonly Row<V>[];
  count: number;
  levels: number;
};
type Branch<V> = {
  kind: 1;
  owner?: symbol;
  prefix: Uint8Array;
  own?: readonly [V];
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
    const m = (lo + hi) >>> 1;
    if (cmp(a[m]) < 0) lo = m + 1;
    else hi = m;
  }
  return lo;
}
const leaf = <V>(rows: readonly Row<V>[]): Leaf<V> => ({
  kind: 0,
  rows,
  count: rows.length,
  levels: 1,
});
function common(a: Uint8Array, b: Uint8Array, offset = 0) {
  let i = 0;
  while (i < a.length && i + offset < b.length && a[i] === b[i + offset]) i++;
  return i;
}
function suffixCompare(a: Uint8Array, b: Uint8Array, offset: number) {
  const n = Math.min(a.length, b.length - offset);
  for (let i = 0; i < n; i++)
    if (a[i] !== b[i + offset]) return a[i] - b[i + offset];
  return a.length - (b.length - offset);
}
function* rows<V>(
  n: Tree<V>,
  base: Uint8Array = new Uint8Array(),
): Generator<Row<V>> {
  if (n.kind === 0) {
    for (const [k, v] of n.rows) yield [concat([base, k]), v];
    return;
  }
  const here = concat([base, n.prefix]);
  if (n.own) yield [here.slice(), n.own[0]];
  for (const [byte, c] of n.children)
    yield* rows(c, concat([here, new Uint8Array([byte])]));
}
function build<V>(rs: readonly Row<V>[], depth = 0): Tree<V> {
  check(depth < 256, "trie nesting limit");
  if (rs.length <= CAP) return leaf(rs);
  const p = common(rs[0][0], rs[rs.length - 1][0]),
    own = rs[0][0].length === p ? ([rs[0][1]] as const) : undefined,
    children: [number, Tree<V>][] = [];
  for (let lo = own ? 1 : 0; lo < rs.length; ) {
    let hi = lo + 1;
    const byte = rs[lo][0][p];
    while (hi < rs.length && rs[hi][0][p] === byte) hi++;
    children.push([
      byte,
      build(
        rs.slice(lo, hi).map(([k, v]) => [k.subarray(p + 1), v] as const),
        depth + 1,
      ),
    ]);
    lo = hi;
  }
  return {
    kind: 1,
    prefix: rs[0][0].slice(0, p),
    own,
    children,
    count: rs.length,
    levels: 1 + Math.max(...children.map(([, c]) => c.levels)),
  };
}
/** Prepend only a boundary prefix; descendants remain shared. */
function prepend<V>(p: Uint8Array, n: Tree<V>): Tree<V> {
  if (!p.length || !n.count) return n;
  return n.kind === 0
    ? leaf(n.rows.map(([k, v]) => [concat([p, k]), v] as const))
    : { ...n, prefix: concat([p, n.prefix]) };
}
function branch<V>(
  prefix: Uint8Array,
  own: readonly [V] | undefined,
  children: readonly (readonly [number, Tree<V>])[],
): Tree<V> {
  const count = (own ? 1 : 0) + children.reduce((s, [, c]) => s + c.count, 0),
    levels = 1 + Math.max(0, ...children.map(([, c]) => c.levels));
  return normalized({ kind: 1, prefix, own, children, count, levels });
}

function find<V>(
  root: Tree<V>,
  k: Uint8Array,
  offset = 0,
): readonly [V] | undefined {
  let n = root;
  for (let depth = 0; depth < 256; depth++) {
    if (n.kind === 0) {
      const at = lower(n.rows, (r) => suffixCompare(r[0], k, offset));
      return at < n.rows.length && suffixCompare(n.rows[at][0], k, offset) === 0
        ? [n.rows[at][1]]
        : undefined;
    }
    if (common(n.prefix, k, offset) !== n.prefix.length) return;
    offset += n.prefix.length;
    if (offset === k.length) return n.own;
    const byte = k[offset++],
      at = lower(n.children, ([b]) => b - byte);
    if (at === n.children.length || n.children[at][0] !== byte) return;
    n = n.children[at][1];
  }
  throw Error("trie nesting limit");
}
function edit<V>(
  n: Tree<V>,
  k: Uint8Array,
  value: V | undefined,
  remove: boolean,
  offset = 0,
): Tree<V> {
  if (n.kind === 0) {
    const at = lower(n.rows, (r) => suffixCompare(r[0], k, offset)),
      exists =
        at < n.rows.length && suffixCompare(n.rows[at][0], k, offset) === 0;
    if (
      (remove && !exists) ||
      (exists && !remove && Object.is(n.rows[at][1], value))
    )
      return n;
    const next = n.rows.slice();
    if (remove) next.splice(at, 1);
    else next.splice(at, exists ? 1 : 0, [k.slice(offset), value as V]);
    return build(next);
  }
  const p = common(n.prefix, k, offset);
  if (p < n.prefix.length) {
    if (remove) return n;
    const own = offset + p === k.length ? ([value as V] as const) : undefined,
      children: [number, Tree<V>][] = [
        [n.prefix[p], { ...n, prefix: n.prefix.slice(p + 1) }],
      ];
    if (!own)
      children.push([
        k[offset + p],
        leaf([[k.slice(offset + p + 1), value as V]]),
      ]);
    children.sort((a, b) => a[0] - b[0]);
    return branch(n.prefix.slice(0, p), own, children);
  }
  offset += p;
  if (offset === k.length) {
    if ((remove && !n.own) || (n.own && !remove && Object.is(n.own[0], value)))
      return n;
    return normalized({
      ...n,
      own: remove ? undefined : [value as V],
      count: n.count + (remove ? -1 : n.own ? 0 : 1),
    });
  }
  const byte = k[offset++],
    at = lower(n.children, ([b]) => b - byte),
    exists = at < n.children.length && n.children[at][0] === byte;
  if (!exists && remove) return n;
  const prior = exists ? n.children[at][1] : leaf<V>([]),
    child = edit(prior, k, value, remove, offset);
  if (prior === child) return n;
  const children = n.children.slice();
  if (!child.count) children.splice(at, 1);
  else children.splice(at, exists ? 1 : 0, [byte, child]);
  return normalized({
    ...n,
    children,
    count: n.count + child.count - prior.count,
    levels: levelsAfter(
      n.levels,
      prior.levels,
      child.count ? child.levels : 0,
      children,
    ),
  });
}
/** Instrument separately from timings; counts structural claims/reuses, not payload copies. */
export type TrieMutationMetrics = {
  copies: number;
  reuses: number;
  rebuildEntries: number;
  snapshots: number;
};
export function trieMutationMetrics(): TrieMutationMetrics {
  return { copies: 0, reuses: 0, rebuildEntries: 0, snapshots: 0 };
}
type Owner = { token: symbol; writes: number; metrics?: TrieMutationMetrics };
function claim<V, T extends Tree<V>>(n: T, owner: Owner): T {
  if (n.owner === owner.token) {
    if (owner.metrics) owner.metrics.reuses++;
    return n;
  }
  if (owner.metrics) owner.metrics.copies++;
  return (
    n.kind === 0
      ? { ...n, owner: owner.token, rows: n.rows.slice() }
      : { ...n, owner: owner.token, children: n.children.slice() }
  ) as T;
}
function levelsAfter<V>(
  levels: number,
  prior: number,
  child: number,
  children: readonly (readonly [number, Tree<V>])[],
) {
  if (child + 1 > levels) return child + 1;
  return child < prior && prior + 1 === levels
    ? 1 + Math.max(0, ...children.map(([, c]) => c.levels))
    : levels;
}
function normalized<V>(n: Branch<V>, owner?: Owner): Tree<V> {
  check(
    Number.isSafeInteger(n.count),
    "logical trie size exceeds safe integer limit",
  );
  if (n.count <= CAP) {
    if (owner?.metrics) owner.metrics.rebuildEntries += n.count;
    return owner
      ? { ...leaf([...rows(n)]), owner: owner.token }
      : leaf([...rows(n)]);
  }
  if (!n.own && n.children.length === 1)
    return prepend(
      concat([n.prefix, new Uint8Array([n.children[0][0]])]),
      n.children[0][1],
    );
  check(n.levels <= 256, "trie nesting limit");
  return n;
}
function editOwned<V>(
  n: Tree<V>,
  k: Uint8Array,
  value: V | undefined,
  remove: boolean,
  owner: Owner,
  offset = 0,
): Tree<V> {
  if (n.kind === 0) {
    const at = lower(n.rows, (r) => suffixCompare(r[0], k, offset));
    const exists =
      at < n.rows.length && suffixCompare(n.rows[at][0], k, offset) === 0;
    if (
      (remove && !exists) ||
      (exists && !remove && Object.is(n.rows[at][1], value))
    )
      return n;
    const next = claim(n, owner),
      rs = next.rows as Row<V>[];
    if (remove) rs.splice(at, 1);
    else rs.splice(at, exists ? 1 : 0, [k.slice(offset), value as V]);
    owner.writes++;
    next.count = rs.length;
    if (rs.length <= CAP) return next;
    if (owner.metrics) owner.metrics.rebuildEntries += rs.length;
    return { ...build(rs), owner: owner.token };
  }
  const p = common(n.prefix, k, offset);
  if (p < n.prefix.length) {
    if (remove) return n;
    const own = offset + p === k.length ? ([value as V] as const) : undefined;
    const children: [number, Tree<V>][] = [
      [n.prefix[p], { ...n, prefix: n.prefix.slice(p + 1) }],
    ];
    if (!own)
      children.push([
        k[offset + p],
        leaf([[k.slice(offset + p + 1), value as V]]),
      ]);
    children.sort((a, b) => a[0] - b[0]);
    owner.writes++;
    return {
      ...branch(n.prefix.slice(0, p), own, children),
      owner: owner.token,
    };
  }
  offset += p;
  if (offset === k.length) {
    if ((remove && !n.own) || (n.own && !remove && Object.is(n.own[0], value)))
      return n;
    const next = claim(n, owner);
    next.count += remove ? -1 : next.own ? 0 : 1;
    next.own = remove ? undefined : [value as V];
    owner.writes++;
    return normalized(next, owner);
  }
  const byte = k[offset++],
    at = lower(n.children, ([b]) => b - byte),
    exists = at < n.children.length && n.children[at][0] === byte;
  if (!exists && remove) return n;
  const writes = owner.writes,
    prior = exists ? n.children[at][1] : leaf<V>([]),
    priorCount = prior.count,
    priorLevels = prior.levels,
    child = editOwned(prior, k, value, remove, owner, offset);
  if (owner.writes === writes) return n;
  const next = claim(n, owner),
    children = next.children as (readonly [number, Tree<V>])[];
  if (!child.count) children.splice(at, 1);
  else children.splice(at, exists ? 1 : 0, [byte, child]);
  next.count += child.count - priorCount;
  next.levels = levelsAfter(
    next.levels,
    priorLevels,
    child.count ? child.levels : 0,
    children,
  );
  return normalized(next, owner);
}

/** Return a relative selected subtree and the original-coordinate remainder. */
function split<V>(n: Tree<V>, p: Uint8Array, offset = 0): [Tree<V>, Tree<V>] {
  if (offset === p.length) return [n, leaf([])];
  if (n.kind === 0) {
    const selected: Row<V>[] = [],
      rest: Row<V>[] = [];
    for (const row of n.rows) {
      if (common(row[0], p, offset) === p.length - offset)
        selected.push([row[0].slice(p.length - offset), row[1]]);
      else rest.push(row);
    }
    return [leaf(selected), selected.length ? leaf(rest) : n];
  }
  const c = common(n.prefix, p, offset);
  if (c === p.length - offset)
    return [{ ...n, prefix: n.prefix.slice(c) }, leaf([])];
  if (c < n.prefix.length) return [leaf([]), n];
  const byte = p[offset + c],
    at = lower(n.children, ([b]) => b - byte);
  if (at === n.children.length || n.children[at][0] !== byte)
    return [leaf([]), n];
  const [selected, remaining] = split(n.children[at][1], p, offset + c + 1);
  if (!selected.count) return [selected, n];
  const children = n.children.slice();
  if (remaining.count) children[at] = [byte, remaining];
  else children.splice(at, 1);
  return [selected, branch(n.prefix, n.own, children)];
}
/** Join disjoint relative trees, touching overlapping boundaries rather than descendants. */
function join<V>(a: Tree<V>, b: Tree<V>): Tree<V> {
  if (!a.count) return b;
  if (!b.count) return a;
  if (a.kind === 0 || b.kind === 0) {
    let result = a.kind === 0 ? b : a;
    const small = a.kind === 0 ? a : b;
    for (const [k, v] of rows(small)) {
      check(!find(result, k), "graft collision");
      result = edit(result, k, v, false);
    }
    return result;
  }
  const p = common(a.prefix, b.prefix);
  if (p < a.prefix.length && p < b.prefix.length) {
    const children: [number, Tree<V>][] = [
      [a.prefix[p], { ...a, prefix: a.prefix.slice(p + 1) }],
      [b.prefix[p], { ...b, prefix: b.prefix.slice(p + 1) }],
    ];
    children.sort((a, b) => a[0] - b[0]);
    return branch(a.prefix.slice(0, p), undefined, children);
  }
  if (p === a.prefix.length && p === b.prefix.length) {
    check(!a.own || !b.own, "graft collision");
    const children = a.children.slice();
    for (const [byte, child] of b.children) {
      const at = lower(children, ([x]) => x - byte);
      if (at < children.length && children[at][0] === byte)
        children[at] = [byte, join(children[at][1], child)];
      else children.splice(at, 0, [byte, child]);
    }
    return branch(a.prefix, a.own ?? b.own, children);
  }
  const short = p === a.prefix.length ? a : b,
    long = short === a ? b : a,
    byte = long.prefix[p],
    children = short.children.slice(),
    at = lower(children, ([x]) => x - byte),
    child: Tree<V> = { ...long, prefix: long.prefix.slice(p + 1) };
  if (at < children.length && children[at][0] === byte)
    children[at] = [byte, join(children[at][1], child)];
  else children.splice(at, 0, [byte, child]);
  return branch(short.prefix, short.own, children);
}
export type GraftMode = "error" | "replace";
/** Path-copied relative byte trie. Prefix handles share untouched descendants. */
export class TrieMap<V> {
  private constructor(private readonly tree: Tree<V>) {}
  static from<V>(
    input: Iterable<readonly [Uint8Array | string, V]>,
  ): TrieMap<V> {
    const rs: Row<V>[] = [];
    for (const [k, v] of input) rs.push([key(k), v]);
    rs.sort((a, b) => compare(a[0], b[0]));
    for (let i = 1; i < rs.length; i++)
      check(compare(rs[i - 1][0], rs[i][0]) !== 0, "duplicate trie key");
    return new TrieMap(build(rs));
  }
  /** Mutable structure with borrowed immutable payloads; snapshot rotates ownership. */
  mutate(metrics?: TrieMutationMetrics): TrieMutation<V> {
    return new Mutation(
      this,
      this.tree,
      (n) => new TrieMap(n),
      (m) => m.tree,
      metrics,
    );
  }
  get size() {
    return this.tree.count;
  }
  get(raw: Uint8Array | string): V | undefined {
    return find(this.tree, key(raw))?.[0];
  }
  has(raw: Uint8Array | string) {
    return find(this.tree, key(raw)) !== undefined;
  }
  /** Longest stored prefix of a key, used by lazy splice routing. */
  longestPrefix(raw: Uint8Array | string): [Uint8Array, V] | undefined {
    const k = key(raw);
    let n = this.tree,
      offset = 0,
      best: [Uint8Array, V] | undefined;
    for (let depth = 0; depth < 256; depth++) {
      if (n.kind === 0) {
        for (const [suffix, v] of n.rows)
          if (
            common(suffix, k, offset) === suffix.length &&
            (!best || offset + suffix.length > best[0].length)
          )
            best = [k.slice(0, offset + suffix.length), v];
        return best;
      }
      if (common(n.prefix, k, offset) !== n.prefix.length) return best;
      offset += n.prefix.length;
      if (n.own) best = [k.slice(0, offset), n.own[0]];
      if (offset === k.length) return best;
      const byte = k[offset++],
        at = lower(n.children, ([b]) => b - byte);
      if (at === n.children.length || n.children[at][0] !== byte) return best;
      n = n.children[at][1];
    }
    throw Error("trie nesting limit");
  }
  set(raw: Uint8Array | string, value: V) {
    const next = edit(this.tree, key(raw), value, false);
    return next === this.tree ? this : new TrieMap(next);
  }
  delete(raw: Uint8Array | string) {
    const next = edit(this.tree, key(raw), undefined, true);
    return next === this.tree ? this : new TrieMap(next);
  }
  /** Prefix bytes are stripped from the selected handle's keys. */
  splitPrefix(raw: Uint8Array | string): {
    subtree: TrieMap<V>;
    rest: TrieMap<V>;
  } {
    const [selected, rest] = split(this.tree, key(raw));
    return {
      subtree: new TrieMap(selected),
      rest: rest === this.tree ? this : new TrieMap(rest),
    };
  }
  subtree(raw: Uint8Array | string) {
    return this.splitPrefix(raw).subtree;
  }
  deletePrefix(raw: Uint8Array | string) {
    return this.splitPrefix(raw).rest;
  }
  graftPrefix(
    raw: Uint8Array | string,
    subtree: TrieMap<V>,
    mode: GraftMode = "error",
  ): TrieMap<V> {
    check(mode === "error" || mode === "replace", "invalid graft mode");
    const p = key(raw),
      [existing, rest] = split(this.tree, p);
    check(
      mode === "replace" || !existing.count,
      "graft destination is not empty",
    );
    const next = join(rest, prepend(p, subtree.tree));
    return next === this.tree ? this : new TrieMap(next);
  }
  *entries(): Generator<[Uint8Array, V]> {
    for (const [k, v] of rows(this.tree)) yield [k, v];
  }
}

export interface TrieMutation<V> {
  readonly size: number;
  get(key: Uint8Array | string): V | undefined;
  has(key: Uint8Array | string): boolean;
  set(key: Uint8Array | string, value: V): void;
  delete(key: Uint8Array | string): void;
  deletePrefix(prefix: Uint8Array | string): void;
  graftPrefix(
    prefix: Uint8Array | string,
    subtree: TrieMap<V>,
    mode?: GraftMode,
  ): void;
  entries(): Generator<[Uint8Array, V]>;
  snapshot(): TrieMap<V>;
  finish(): TrieMap<V>;
  abort(): void;
}
/** Writable nodes never leave this scope under its current ownership token. */
class Mutation<V> implements TrieMutation<V> {
  #tree: Tree<V> | undefined;
  #map: TrieMap<V> | undefined;
  #owner: Owner | undefined;
  #dirty = false;
  constructor(
    base: TrieMap<V>,
    tree: Tree<V>,
    private readonly wrap: (n: Tree<V>) => TrieMap<V>,
    private readonly unwrap: (m: TrieMap<V>) => Tree<V>,
    private readonly metrics?: TrieMutationMetrics,
  ) {
    this.#tree = tree;
    this.#map = base;
    this.#owner = { token: Symbol(), writes: 0, metrics };
  }
  private check() {
    check(this.#owner, "trie mutation scope is closed");
  }
  get size() {
    this.check();
    return this.#tree!.count;
  }
  get(raw: Uint8Array | string) {
    this.check();
    return find(this.#tree!, key(raw))?.[0];
  }
  has(raw: Uint8Array | string) {
    this.check();
    return find(this.#tree!, key(raw)) !== undefined;
  }
  private write(
    raw: Uint8Array | string,
    value: V | undefined,
    remove: boolean,
  ) {
    this.check();
    try {
      const owner = this.#owner!,
        writes = owner.writes;
      this.#tree = editOwned(this.#tree!, key(raw), value, remove, owner);
      if (writes !== owner.writes) this.#dirty = true;
    } catch (error) {
      this.abort();
      throw error;
    }
  }
  set(raw: Uint8Array | string, value: V) {
    this.write(raw, value, false);
  }
  delete(raw: Uint8Array | string) {
    this.write(raw, undefined, true);
  }
  snapshot() {
    this.check();
    if (this.#dirty) {
      this.#map = this.wrap(this.#tree!);
      this.#dirty = false;
    }
    this.#owner = { token: Symbol(), writes: 0, metrics: this.metrics };
    if (this.metrics) this.metrics.snapshots++;
    return this.#map!;
  }
  entries() {
    return this.snapshot().entries();
  }
  private replace(next: TrieMap<V>) {
    this.#map = next;
    this.#tree = this.unwrap(next);
    this.#dirty = false;
  }
  deletePrefix(raw: Uint8Array | string) {
    this.check();
    try {
      this.replace(this.snapshot().deletePrefix(raw));
    } catch (error) {
      this.abort();
      throw error;
    }
  }
  graftPrefix(
    raw: Uint8Array | string,
    subtree: TrieMap<V>,
    mode: GraftMode = "error",
  ) {
    this.check();
    try {
      this.replace(this.snapshot().graftPrefix(raw, subtree, mode));
    } catch (error) {
      this.abort();
      throw error;
    }
  }
  finish() {
    const result = this.snapshot();
    this.abort();
    return result;
  }
  abort() {
    this.#owner = undefined;
    this.#tree = undefined;
    this.#map = undefined;
  }
}
