/** Path-copied configurable bitmap vector. Holes differ from stored undefined/null. */
import { check } from "./core";
import {
  type Bitmap,
  vectorBits,
  emptyBitmap,
  has,
  rank,
  changeBit,
} from "./vector-bitmap";
type Tree<V> = {
  owner?: symbol;
  shift: number;
  bitmap: Bitmap;
  slots: readonly (Tree<V> | V)[];
  count: number;
};
const valid = (i: bigint) =>
  check(typeof i === "bigint" && i >= 0n, "invalid vector index");
function shiftFor(length: bigint, bits: number) {
  let s = 0;
  while (length > 1n << BigInt(s + bits)) s += bits;
  check(s / bits < 256, "vector nesting limit");
  return s;
}
const empty = <V>(shift: number, bits: number): Tree<V> => ({
  shift,
  bitmap: emptyBitmap(bits),
  slots: [],
  count: 0,
});
export type VectorMutationMetrics = {
  copiedNodes: number;
  slotsCopied: number;
  writes: number;
  snapshots: number;
};
type Owner = { token: symbol; writes: number; metrics?: VectorMutationMetrics };
function writable<V>(n: Tree<V>, owner?: Owner): Tree<V> {
  if (owner && n.owner === owner.token) return n;
  if (owner?.metrics) {
    owner.metrics.copiedNodes++;
    owner.metrics.slotsCopied += n.slots.length;
  }
  return { ...n, slots: n.slots.slice(), owner: owner?.token };
}
function changed<V>(
  n: Tree<V>,
  i: bigint,
  value: V | undefined,
  remove: boolean,
  bits: number,
  owner?: Owner,
): Tree<V> {
  const slot = Number((i >> BigInt(n.shift)) & BigInt((1 << bits) - 1)),
    at = rank(n.bitmap, slot),
    exists = has(n.bitmap, slot);
  if (!exists && remove) return n;
  if (!n.shift && exists && !remove && Object.is(n.slots[at], value)) return n;
  let child: Tree<V> | undefined,
    priorCount = 0;
  if (n.shift) {
    const prior = exists
        ? (n.slots[at] as Tree<V>)
        : empty<V>(n.shift - bits, bits),
      writes = owner?.writes;
    priorCount = prior.count;
    child = changed(prior, i, value, remove, bits, owner);
    if (child === prior && owner?.writes === writes) return n;
  }
  const out = writable(n, owner),
    slots = out.slots as (Tree<V> | V)[];
  if (!n.shift) {
    if (remove) {
      slots.splice(at, 1);
      out.bitmap = changeBit(out.bitmap, slot, false);
      out.count--;
    } else {
      slots.splice(at, exists ? 1 : 0, value as V);
      out.bitmap = changeBit(out.bitmap, slot, true);
      if (!exists) out.count++;
    }
  } else {
    out.count += child!.count - priorCount;
    if (child!.count) {
      slots.splice(at, exists ? 1 : 0, child!);
      out.bitmap = changeBit(out.bitmap, slot, true);
    } else {
      slots.splice(at, 1);
      out.bitmap = changeBit(out.bitmap, slot, false);
    }
  }
  if (owner) {
    owner.writes++;
    if (owner.metrics) owner.metrics.writes++;
  }
  return out;
}
function trim<V>(
  n: Tree<V>,
  base: bigint,
  length: bigint,
  bits: number,
): Tree<V> {
  if (base + (1n << BigInt(n.shift + bits)) <= length) return n;
  if (base >= length) return empty(n.shift, bits);
  const slots: (Tree<V> | V)[] = [];
  let bitmap = emptyBitmap(bits),
    count = 0,
    at = 0;
  for (let s = 0; s < 1 << bits; s++)
    if (has(n.bitmap, s)) {
      const lo = base + (BigInt(s) << BigInt(n.shift)),
        v = n.slots[at++];
      if (lo >= length) continue;
      const child = n.shift ? trim(v as Tree<V>, lo, length, bits) : v;
      if (n.shift && !(child as Tree<V>).count) continue;
      slots.push(child);
      bitmap = changeBit(bitmap, s, true);
      count += n.shift ? (child as Tree<V>).count : 1;
    }
  if (count === n.count) return n;
  return { shift: n.shift, bitmap, slots, count };
}
/** Numeric indices and immutable logical snapshots; no serialization or hashing. */
export class VectorMap<V> {
  private constructor(
    readonly length: bigint,
    readonly bits: number,
    private readonly tree: Tree<V>,
  ) {}
  static from<V>(
    length: bigint,
    input: Iterable<readonly [bigint, V]>,
    bits = 5,
  ): VectorMap<V> {
    valid(length);
    vectorBits(bits);
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
      let bitmap = emptyBitmap(bits);
      for (let at = lo; at < end;) {
        const slot = Number(
            (rows[at][0] >> BigInt(shift)) & BigInt((1 << bits) - 1),
          ),
          bound = base + (BigInt(slot + 1) << BigInt(shift));
        let next = at + 1;
        while (next < end && rows[next][0] < bound) next++;
        bitmap = changeBit(bitmap, slot, true);
        slots.push(
          shift
            ? build(
                at,
                next,
                base + (BigInt(slot) << BigInt(shift)),
                shift - bits,
              )
            : rows[at][1],
        );
        at = next;
      }
      return { shift, bitmap, slots, count: end - lo };
    }
    return new VectorMap(
      length,
      bits,
      build(0, rows.length, 0n, shiftFor(length, bits)),
    );
  }

  mutate(metrics?: VectorMutationMetrics): VectorMutation<V> {
    return new Mutation(
      this,
      this.tree,
      (length, tree) => new VectorMap(length, this.bits, tree),
      (m) => m.tree,
      metrics,
    );
  }
  get size() {
    return this.tree.count;
  }
  private find(i: bigint): { value: V } | undefined {
    valid(i);
    if (i >= this.length) return;
    const bits = this.bits;
    let n = this.tree;
    for (;;) {
      const slot = Number((i >> BigInt(n.shift)) & BigInt((1 << bits) - 1));
      if (!has(n.bitmap, slot)) return;
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
    const tree = changed(this.tree, i, value, false, this.bits);
    return tree === this.tree
      ? this
      : new VectorMap(this.length, this.bits, tree);
  }
  delete(i: bigint): VectorMap<V> {
    valid(i);
    check(i < this.length, "vector index outside length");
    const tree = changed(this.tree, i, undefined, true, this.bits);
    return tree === this.tree
      ? this
      : new VectorMap(this.length, this.bits, tree);
  }
  resize(length: bigint): VectorMap<V> {
    valid(length);
    if (length === this.length) return this;
    const bits = this.bits,
      shift = shiftFor(length, bits);
    let tree = this.tree;
    while (tree.shift < shift)
      tree = tree.count
        ? {
            shift: tree.shift + bits,
            bitmap: changeBit(emptyBitmap(bits), 0, true),
            slots: [tree],
            count: tree.count,
          }
        : empty(tree.shift + bits, bits);
    while (tree.shift > shift)
      tree = has(tree.bitmap, 0)
        ? (tree.slots[0] as Tree<V>)
        : empty(tree.shift - bits, bits);
    if (length < this.length) tree = trim(tree, 0n, length, bits);
    return new VectorMap(length, bits, tree);
  }
  push(value: V) {
    return this.resize(this.length + 1n).set(this.length, value);
  }
  pop() {
    return this.resize(this.length ? this.length - 1n : 0n);
  }
  *entries(): Generator<[bigint, V]> {
    const bits = this.bits;
    function* walk<V>(n: Tree<V>, base: bigint): Generator<[bigint, V]> {
      let at = 0;
      for (let s = 0; s < 1 << bits; s++)
        if (has(n.bitmap, s)) {
          const i = base + (BigInt(s) << BigInt(n.shift)),
            v = n.slots[at++];
          if (n.shift) yield* walk(v as Tree<V>, i);
          else yield [i, v as V];
        }
    }
    yield* walk(this.tree, 0n);
  }
}

export interface VectorMutation<V> {
  readonly length: bigint;
  readonly bits: number;
  readonly size: number;
  get(i: bigint): V | undefined;
  has(i: bigint): boolean;
  set(i: bigint, value: V): void;
  delete(i: bigint): void;
  resize(length: bigint): void;
  push(value: V): void;
  pop(): void;
  entries(): Generator<[bigint, V]>;
  snapshot(): VectorMap<V>;
  finish(): VectorMap<V>;
  abort(): void;
}
class Mutation<V> implements VectorMutation<V> {
  #tree: Tree<V> | undefined;
  #map: VectorMap<V> | undefined;
  #owner: Owner | undefined;
  #dirty = false;
  #length: bigint;
  constructor(
    base: VectorMap<V>,
    tree: Tree<V>,
    private readonly wrap: (length: bigint, n: Tree<V>) => VectorMap<V>,
    private readonly unwrap: (m: VectorMap<V>) => Tree<V>,
    private readonly metrics?: VectorMutationMetrics,
  ) {
    this.#tree = tree;
    this.#map = base;
    this.#length = base.length;
    this.#owner = { token: Symbol(), writes: 0, metrics };
  }
  private check() {
    check(this.#owner, "vector mutation scope is closed");
  }
  get bits() {
    this.check();
    return this.#map!.bits;
  }
  get length() {
    this.check();
    return this.#length;
  }
  get size() {
    this.check();
    return this.#tree!.count;
  }
  get(i: bigint) {
    this.check();
    return this.wrap(this.#length, this.#tree!).get(i);
  }
  has(i: bigint) {
    this.check();
    return this.wrap(this.#length, this.#tree!).has(i);
  }
  private write(i: bigint, value: V | undefined, remove: boolean) {
    this.check();
    try {
      valid(i);
      check(i < this.#length, "vector index outside length");
      const owner = this.#owner!,
        writes = owner.writes;
      this.#tree = changed(this.#tree!, i, value, remove, this.bits, owner);
      if (writes !== owner.writes) this.#dirty = true;
    } catch (e) {
      this.abort();
      throw e;
    }
  }
  set(i: bigint, v: V) {
    this.write(i, v, false);
  }
  delete(i: bigint) {
    this.write(i, undefined, true);
  }
  snapshot() {
    this.check();
    if (this.#dirty) {
      this.#map = this.wrap(this.#length, this.#tree!);
      this.#dirty = false;
    }
    this.#owner = { token: Symbol(), writes: 0, metrics: this.metrics };
    if (this.metrics) this.metrics.snapshots++;
    return this.#map!;
  }
  entries() {
    return this.snapshot().entries();
  }
  resize(length: bigint) {
    this.check();
    try {
      valid(length);
      if (length === this.#length) return;
      if (length > this.#length) {
        const bits = this.bits,
          shift = shiftFor(length, bits);
        while (this.#tree!.shift < shift) {
          const child = this.#tree!;
          this.#tree = child.count
            ? {
                owner: this.#owner!.token,
                shift: child.shift + bits,
                bitmap: changeBit(emptyBitmap(bits), 0, true),
                slots: [child],
                count: child.count,
              }
            : empty(shift, bits);
        }
        this.#length = length;
        this.#dirty = true;
        return;
      }
      const map = this.snapshot().resize(length);
      this.#map = map;
      this.#tree = this.unwrap(map);
      this.#length = length;
    } catch (e) {
      this.abort();
      throw e;
    }
  }
  push(v: V) {
    this.check();
    this.resize(this.#length + 1n);
    this.set(this.#length - 1n, v);
  }
  pop() {
    this.check();
    this.resize(this.#length ? this.#length - 1n : 0n);
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
