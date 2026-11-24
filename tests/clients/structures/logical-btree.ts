/** Persistent B-tree editing. Keys are owned; values are borrowed immutable payloads. */
import { check, key, compare, equal } from "./core";
type Node<V> = {
  keys: readonly Uint8Array[];
  values: readonly V[];
  children: readonly Node<V>[];
  count: number;
};
const MIN = 15,
  MAX = 31;
const node = <V>(
  keys: readonly Uint8Array[],
  values: readonly V[],
  children: readonly Node<V>[] = [],
): Node<V> => ({
  keys,
  values,
  children,
  count: keys.length + children.reduce((n, c) => n + c.count, 0),
});
function search(keys: readonly Uint8Array[], k: Uint8Array) {
  let lo = 0,
    hi = keys.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (compare(keys[m], k) < 0) lo = m + 1;
    else hi = m;
  }
  return lo;
}
function split<V>(n: Node<V>) {
  const at = n.keys.length >>> 1;
  return {
    key: n.keys[at],
    value: n.values[at],
    left: node(
      n.keys.slice(0, at),
      n.values.slice(0, at),
      n.children.slice(0, at + 1),
    ),
    right: node(
      n.keys.slice(at + 1),
      n.values.slice(at + 1),
      n.children.slice(at + 1),
    ),
  };
}
function insert<V>(n: Node<V>, k: Uint8Array, v: V): Node<V> {
  const at = search(n.keys, k),
    keys = n.keys.slice(),
    values = n.values.slice(),
    children = n.children.slice();
  if (at < keys.length && equal(keys[at], k)) {
    if (Object.is(values[at], v)) return n;
    values[at] = v;
  } else if (!children.length) {
    keys.splice(at, 0, k);
    values.splice(at, 0, v);
  } else {
    const c = insert(children[at], k, v);
    if (c === children[at]) return n;
    if (c.keys.length > MAX) {
      const s = split(c);
      keys.splice(at, 0, s.key);
      values.splice(at, 0, s.value);
      children.splice(at, 1, s.left, s.right);
    } else children[at] = c;
  }
  return node(keys, values, children);
}
function remove<V>(n: Node<V>, k: Uint8Array): Node<V> {
  const at = search(n.keys, k),
    found = at < n.keys.length && equal(n.keys[at], k);
  if (!n.children.length) {
    if (!found) return n;
    const keys = n.keys.slice(),
      values = n.values.slice();
    keys.splice(at, 1);
    values.splice(at, 1);
    return node(keys, values);
  }
  const keys = n.keys.slice(),
    values = n.values.slice(),
    children = n.children.slice();
  let target = k;
  if (found) {
    let last = children[at];
    while (last.children.length) last = last.children.at(-1)!;
    target = last.keys.at(-1)!;
    keys[at] = target;
    values[at] = last.values.at(-1)!;
  }
  const c = remove(children[at], target);
  if (c === children[at]) return n;
  children[at] = c;
  if (c.keys.length < MIN) {
    const left = children[at - 1],
      right = children[at + 1];
    if (left && left.keys.length > MIN) {
      children[at] = node(
        [keys[at - 1], ...c.keys],
        [values[at - 1], ...c.values],
        c.children.length ? [left.children.at(-1)!, ...c.children] : [],
      );
      keys[at - 1] = left.keys.at(-1)!;
      values[at - 1] = left.values.at(-1)!;
      children[at - 1] = node(
        left.keys.slice(0, -1),
        left.values.slice(0, -1),
        left.children.slice(0, -1),
      );
    } else if (right && right.keys.length > MIN) {
      children[at] = node(
        [...c.keys, keys[at]],
        [...c.values, values[at]],
        c.children.length ? [...c.children, right.children[0]] : [],
      );
      keys[at] = right.keys[0];
      values[at] = right.values[0];
      children[at + 1] = node(
        right.keys.slice(1),
        right.values.slice(1),
        right.children.slice(1),
      );
    } else {
      const i = left ? at - 1 : at,
        a = children[i],
        b = children[i + 1];
      children.splice(
        i,
        2,
        node(
          [...a.keys, keys[i], ...b.keys],
          [...a.values, values[i], ...b.values],
          [...a.children, ...b.children],
        ),
      );
      keys.splice(i, 1);
      values.splice(i, 1);
    }
  }
  return node(keys, values, children);
}
export class BTreeMap<V> {
  private constructor(private readonly root: Node<V>) {}
  static empty<V>() {
    return new BTreeMap<V>(node([], []));
  }
  static from<V>(rows: Iterable<[Uint8Array | string, V]>) {
    let tree = BTreeMap.empty<V>();
    for (const [k, v] of rows) tree = tree.set(k, v);
    return tree;
  }
  get size() {
    return this.root.count;
  }
  private lookup(raw: Uint8Array | string): [Node<V>, number] | undefined {
    const k = key(raw);
    let n = this.root;
    for (;;) {
      const at = search(n.keys, k);
      if (at < n.keys.length && equal(n.keys[at], k)) return [n, at];
      if (!n.children.length) return;
      n = n.children[at];
    }
  }
  has(k: Uint8Array | string) {
    return this.lookup(k) !== undefined;
  }
  get(k: Uint8Array | string): V | undefined {
    const hit = this.lookup(k);
    return hit?.[0].values[hit[1]];
  }
  set(raw: Uint8Array | string, v: V) {
    let n = insert(this.root, key(raw), v);
    if (n === this.root) return this;
    if (n.keys.length > MAX) {
      const s = split(n);
      n = node([s.key], [s.value], [s.left, s.right]);
    }
    return new BTreeMap(n);
  }
  delete(raw: Uint8Array | string) {
    let n = remove(this.root, key(raw));
    if (n === this.root) return this;
    if (!n.keys.length && n.children.length) n = n.children[0];
    return new BTreeMap(n);
  }
  *entries(
    from: Uint8Array | string = new Uint8Array(),
    to?: Uint8Array | string,
  ): Generator<[Uint8Array, V]> {
    const lo = key(from),
      hi = to === undefined ? undefined : key(to);
    check(!hi || compare(lo, hi) <= 0, "invalid B-tree range");
    function* visit(n: Node<V>): Generator<[Uint8Array, V]> {
      const start = search(n.keys, lo);
      for (let i = start; i <= n.keys.length; i++) {
        if (n.children.length) yield* visit(n.children[i]);
        if (i === n.keys.length || (hi && compare(n.keys[i], hi) >= 0)) return;
        yield [new Uint8Array(n.keys[i]), n.values[i]];
      }
    }
    yield* visit(this.root);
  }
  /** Structural audit useful for fuzzing editors without exporting them. */
  validate(): void {
    let leafDepth: number | undefined;
    function walk(
      n: Node<V>,
      depth: number,
      root: boolean,
      lo?: Uint8Array,
      hi?: Uint8Array,
    ): number {
      check(
        n.keys.length <= MAX && (root || n.keys.length >= MIN),
        "B-tree occupancy",
      );
      check(
        n.values.length === n.keys.length &&
          (!n.children.length || n.children.length === n.keys.length + 1),
        "B-tree arity",
      );
      for (let i = 0; i < n.keys.length; i++)
        check(
          (!i || compare(n.keys[i - 1], n.keys[i]) < 0) &&
            (!lo || compare(lo, n.keys[i]) < 0) &&
            (!hi || compare(n.keys[i], hi) < 0),
          "B-tree key order",
        );
      let count = n.keys.length;
      if (n.children.length)
        for (let i = 0; i < n.children.length; i++)
          count += walk(
            n.children[i],
            depth + 1,
            false,
            i ? n.keys[i - 1] : lo,
            i < n.keys.length ? n.keys[i] : hi,
          );
      else {
        leafDepth ??= depth;
        check(leafDepth === depth, "B-tree leaf depth");
      }
      check(count === n.count, "B-tree count");
      return count;
    }
    walk(this.root, 0, true);
  }
}
