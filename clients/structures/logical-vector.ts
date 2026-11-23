/** Path-copied 32-way bitmap vector. Holes differ from stored undefined/null. */
import { check } from "./core";
type Tree<V> = {
  shift: number;
  bitmap: number;
  slots: readonly (Tree<V> | V)[];
  count: number;
};
const valid = (i: bigint) =>
  check(typeof i === "bigint" && i >= 0n, "invalid vector index");
function shiftFor(length: bigint) {
  let s = 0;
  while (length > 1n << BigInt(s + 5)) s += 5;
  check(s < 1280, "vector nesting limit");
  return s;
}
function rank(bitmap: number, slot: number) {
  let n = 0,
    b = (bitmap & (2 ** slot - 1)) >>> 0;
  while (b) {
    b = (b & (b - 1)) >>> 0;
    n++;
  }
  return n;
}
const has = (n: { bitmap: number }, slot: number) =>
  ((n.bitmap >>> slot) & 1) !== 0;
const empty = <V>(shift: number): Tree<V> => ({
  shift,
  bitmap: 0,
  slots: [],
  count: 0,
});
function changed<V>(
  n: Tree<V>,
  i: bigint,
  value: V | undefined,
  remove: boolean,
): Tree<V> {
  const slot = Number((i >> BigInt(n.shift)) & 31n),
    at = rank(n.bitmap, slot),
    exists = has(n, slot);
  if (!exists && remove) return n;
  const slots = n.slots.slice();
  let bitmap = n.bitmap,
    count = n.count;
  if (n.shift === 0) {
    if (exists && !remove && Object.is(slots[at], value)) return n;
    if (remove) {
      slots.splice(at, 1);
      bitmap = (bitmap & ~(1 << slot)) >>> 0;
      count--;
    } else {
      slots.splice(at, exists ? 1 : 0, value as V);
      bitmap = (bitmap | (1 << slot)) >>> 0;
      if (!exists) count++;
    }
  } else {
    const prior = exists ? (slots[at] as Tree<V>) : empty<V>(n.shift - 5),
      child = changed(prior, i, value, remove);
    if (prior === child) return n;
    count += child.count - prior.count;
    if (child.count) {
      slots.splice(at, exists ? 1 : 0, child);
      bitmap = (bitmap | (1 << slot)) >>> 0;
    } else {
      slots.splice(at, 1);
      bitmap = (bitmap & ~(1 << slot)) >>> 0;
    }
  }
  return { shift: n.shift, bitmap, slots, count };
}
function trim<V>(n: Tree<V>, base: bigint, length: bigint): Tree<V> {
  if (base + (1n << BigInt(n.shift + 5)) <= length) return n;
  if (base >= length) return empty(n.shift);
  const slots: (Tree<V> | V)[] = [];
  let bitmap = 0,
    count = 0,
    at = 0;
  for (let s = 0; s < 32; s++)
    if (has(n, s)) {
      const lo = base + (BigInt(s) << BigInt(n.shift)),
        v = n.slots[at++];
      if (lo >= length) continue;
      const child = n.shift ? trim(v as Tree<V>, lo, length) : v;
      if (n.shift && !(child as Tree<V>).count) continue;
      slots.push(child);
      bitmap = (bitmap | (1 << s)) >>> 0;
      count += n.shift ? (child as Tree<V>).count : 1;
    }
  if (count === n.count) return n;
  return { shift: n.shift, bitmap, slots, count };
}
/** Numeric indices and immutable logical snapshots; no serialization or hashing. */
export class VectorMap<V> {
  private constructor(
    readonly length: bigint,
    private readonly tree: Tree<V>,
  ) {}
  static from<V>(
    length: bigint,
    input: Iterable<readonly [bigint, V]>,
  ): VectorMap<V> {
    valid(length);
    const rows: [bigint, V][] = [];
    for (const [i, v] of input) {
      valid(i);
      check(i < length, "vector index outside length");
      rows.push([i, v]);
    }
    rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < rows.length; i++)
      check(rows[i - 1][0] !== rows[i][0], "duplicate vector index");
    function build(
      lo: number,
      end: number,
      base: bigint,
      shift: number,
    ): Tree<V> {
      const slots: (Tree<V> | V)[] = [];
      let bitmap = 0;
      for (let at = lo; at < end;) {
        const slot = Number((rows[at][0] >> BigInt(shift)) & 31n),
          bound = base + (BigInt(slot + 1) << BigInt(shift));
        let next = at + 1;
        while (next < end && rows[next][0] < bound) next++;
        bitmap = (bitmap | (1 << slot)) >>> 0;
        slots.push(
          shift
            ? build(at, next, base + (BigInt(slot) << BigInt(shift)), shift - 5)
            : rows[at][1],
        );
        at = next;
      }
      return { shift, bitmap, slots, count: end - lo };
    }
    return new VectorMap(length, build(0, rows.length, 0n, shiftFor(length)));
  }

  get size() {
    return this.tree.count;
  }
  private find(i: bigint): { value: V } | undefined {
    valid(i);
    if (i >= this.length) return;
    let n = this.tree;
    for (;;) {
      const slot = Number((i >> BigInt(n.shift)) & 31n);
      if (!has(n, slot)) return;
      const v = n.slots[rank(n.bitmap, slot)];
      if (!n.shift) return { value: v as V };
      n = v as Tree<V>;
    }
  }
  get(i: bigint): V | undefined {
    return this.find(i)?.value;
  }
  has(i: bigint): boolean {
    return this.find(i) !== undefined;
  }
  set(i: bigint, value: V): VectorMap<V> {
    valid(i);
    check(i < this.length, "vector index outside length");
    const tree = changed(this.tree, i, value, false);
    return tree === this.tree ? this : new VectorMap(this.length, tree);
  }
  delete(i: bigint): VectorMap<V> {
    valid(i);
    check(i < this.length, "vector index outside length");
    const tree = changed(this.tree, i, undefined, true);
    return tree === this.tree ? this : new VectorMap(this.length, tree);
  }
  resize(length: bigint): VectorMap<V> {
    valid(length);
    if (length === this.length) return this;
    const shift = shiftFor(length);
    let tree = this.tree;
    while (tree.shift < shift)
      tree = tree.count
        ? { shift: tree.shift + 5, bitmap: 1, slots: [tree], count: tree.count }
        : empty(tree.shift + 5);
    while (tree.shift > shift)
      tree = has(tree, 0) ? (tree.slots[0] as Tree<V>) : empty(tree.shift - 5);
    if (length < this.length) tree = trim(tree, 0n, length);
    return new VectorMap(length, tree);
  }
  push(value: V) {
    return this.resize(this.length + 1n).set(this.length, value);
  }
  pop() {
    return this.resize(this.length ? this.length - 1n : 0n);
  }
  *entries(): Generator<[bigint, V]> {
    function* walk<V>(n: Tree<V>, base: bigint): Generator<[bigint, V]> {
      let at = 0;
      for (let s = 0; s < 32; s++)
        if (has(n, s)) {
          const i = base + (BigInt(s) << BigInt(n.shift)),
            v = n.slots[at++];
          if (n.shift) yield* walk(v as Tree<V>, i);
          else yield [i, v as V];
        }
    }
    yield* walk(this.tree, 0n);
  }
}
