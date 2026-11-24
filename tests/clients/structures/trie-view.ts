import { summaryReuse } from "./summary";
import { type Piece, type Block, mapPiece, buildPieces } from "./trie-export";
/** Lazy prefix splices: source snapshots are shared, canonical export is explicit. */
import { check, key, concat, compare, object, type Basin } from "./core";
import { Trie, TrieEditor, starts, type Consumer } from "./trie";
import { TrieMap, type GraftMode } from "./logical-trie";
type Point<V> = { value: V } | { deleted: true };
type Base<V, M> =
  | { trie: Trie<V, M>; prefix: Uint8Array }
  | { view: TrieView<V, M>; prefix: Uint8Array };
const blank = () => new Uint8Array();
/** An immutable heap-loadable map view; prefix handles strip their selected prefix. */
export class TrieView<V, M = null> {
  private constructor(
    readonly basin: Basin,
    readonly consumer: Consumer<V, M>,
    private readonly base: Base<V, M> | null,
    private readonly routes = TrieMap.from<TrieView<V, M> | null>([]),
    private readonly points = TrieMap.from<Point<V>>([]),
  ) {}
  static from<V, M>(trie: Trie<V, M>) {
    return new TrieView(trie.basin, trie.consumer, { trie, prefix: blank() });
  }
  static fromEntries<V, M>(
    basin: Basin,
    input: Iterable<readonly [Uint8Array | string, V]>,
    c: Consumer<V, M>,
  ) {
    return new TrieView(
      basin,
      c,
      null,
      TrieMap.from<TrieView<V, M> | null>([]),
      TrieMap.from(
        [...input].map(([k, v]) => [k, { value: v } as Point<V>] as const),
      ),
    );
  }
  private static empty<V, M>(basin: Basin, c: Consumer<V, M>) {
    return new TrieView<V, M>(basin, c, null);
  }
  private async lookup(
    k: Uint8Array,
    depth = 0,
  ): Promise<readonly [V] | undefined> {
    check(depth < 256, "splice nesting limit");
    const own = this.points.get(k);
    if (own) return "value" in own ? [own.value] : undefined;
    const route = this.routes.longestPrefix(k);
    if (route) return route[1]?.lookup(k.subarray(route[0].length), depth + 1);
    if (!this.base) return;
    const at = concat([this.base.prefix, k]);
    if ("view" in this.base) return this.base.view.lookup(at, depth + 1);
    const ref = await this.base.trie.getView(at);
    return ref === undefined ? undefined : [object<V>(ref)];
  }
  async get(raw: Uint8Array | string) {
    return (await this.lookup(key(raw)))?.[0];
  }
  async has(raw: Uint8Array | string) {
    return (await this.lookup(key(raw))) !== undefined;
  }
  set(raw: Uint8Array | string, value: V) {
    return new TrieView(
      this.basin,
      this.consumer,
      this.base,
      this.routes,
      this.points.set(raw, { value }),
    );
  }
  delete(raw: Uint8Array | string) {
    return new TrieView(
      this.basin,
      this.consumer,
      this.base,
      this.routes,
      this.points.set(raw, { deleted: true }),
    );
  }
  deletePrefix(raw: Uint8Array | string) {
    const p = key(raw);
    return new TrieView(
      this.basin,
      this.consumer,
      this.base,
      this.routes.deletePrefix(p).set(p, null),
      this.points.deletePrefix(p),
    );
  }
  subtree(raw: Uint8Array | string): TrieView<V, M> {
    const p = key(raw);
    if (!p.length) return this;
    const ancestor = this.routes.longestPrefix(p),
      below = this.routes.subtree(p).delete("");
    if (!below.size && !this.points.subtree(p).size) {
      if (ancestor)
        return (
          ancestor[1]?.subtree(p.subarray(ancestor[0].length)) ??
          TrieView.empty(this.basin, this.consumer)
        );
      if (!this.base) return TrieView.empty(this.basin, this.consumer);
      return new TrieView(this.basin, this.consumer, {
        ...this.base,
        prefix: concat([this.base.prefix, p]),
      });
    }
    return new TrieView(this.basin, this.consumer, { view: this, prefix: p });
  }
  splitPrefix(raw: Uint8Array | string) {
    const p = key(raw);
    return { subtree: this.subtree(p), rest: this.deletePrefix(p) };
  }
  async graftPrefix(
    raw: Uint8Array | string,
    subtree: TrieView<V, M>,
    mode: GraftMode = "error",
  ) {
    check(mode === "error" || mode === "replace", "invalid graft mode");
    check(
      this.basin === subtree.basin && this.consumer === subtree.consumer,
      "graft storage/consumer mismatch",
    );
    const p = key(raw);
    if (mode === "error") {
      const it = this.entries(p);
      try {
        check((await it.next()).done, "graft destination is not empty");
      } finally {
        await it.return(undefined);
      }
    }
    return this.replacePrefix(p, subtree);
  }
  /** Explicitly replace the destination range; no asynchronous collision probe. */
  replacePrefix(raw: Uint8Array | string, subtree: TrieView<V, M>) {
    check(
      this.basin === subtree.basin && this.consumer === subtree.consumer,
      "graft storage/consumer mismatch",
    );
    const p = key(raw);
    return new TrieView(
      this.basin,
      this.consumer,
      this.base,
      this.routes.deletePrefix(p).set(p, subtree),
      this.points.deletePrefix(p),
    );
  }
  async copyPrefix(
    from: Uint8Array | string,
    to: Uint8Array | string,
    mode: GraftMode = "error",
  ) {
    const a = key(from),
      b = key(to);
    check(!starts(b, a), "destination is inside source");
    const it = this.entries(a);
    try {
      check(!(await it.next()).done, "missing source prefix");
    } finally {
      await it.return(undefined);
    }
    return this.graftPrefix(b, this.subtree(a), mode);
  }
  async movePrefix(
    from: Uint8Array | string,
    to: Uint8Array | string,
    mode: GraftMode = "error",
  ) {
    const a = key(from),
      b = key(to);
    if (compare(a, b) === 0) return this;
    check(!starts(b, a), "destination is inside source");
    const it = this.entries(a);
    try {
      check(!(await it.next()).done, "missing source prefix");
    } finally {
      await it.return(undefined);
    }
    const { subtree, rest } = this.splitPrefix(a);
    return rest.graftPrefix(b, subtree, mode);
  }
  private async *scan(
    p: Uint8Array,
    excluded: readonly Uint8Array[],
    depth = 0,
  ): AsyncGenerator<[Uint8Array, V]> {
    check(depth < 256, "splice nesting limit");
    if (excluded.some((x) => starts(p, x))) return;
    const routes = [...this.routes.entries()],
      blocked = (k: Uint8Array) => excluded.some((x) => starts(k, x));
    const streams: AsyncGenerator<[Uint8Array, V]>[] = [];
    if (this.base) {
      const base = this.base,
        all = [...excluded, ...routes.map(([k]) => k)].map((x) =>
          concat([base.prefix, x]),
        );
      const source =
        "trie" in base
          ? base.trie.entries(concat([base.prefix, p]), undefined, all)
          : base.view.scan(concat([base.prefix, p]), all, depth + 1);
      const self = this;
      streams.push(
        (async function* () {
          for await (const [k, v] of source) {
            const relative = k.slice(base.prefix.length);
            if (!self.points.has(relative)) yield [relative, v];
          }
        })(),
      );
    }
    for (const [prefix, view] of routes) {
      if (
        !view ||
        blocked(prefix) ||
        (!starts(prefix, p) && !starts(p, prefix))
      )
        continue;
      const below = [
        ...excluded,
        ...routes
          .filter(
            ([other]) => other.length > prefix.length && starts(other, prefix),
          )
          .map(([other]) => other),
      ]
        .filter((x) => starts(x, prefix))
        .map((x) => x.slice(prefix.length));
      const suffix = starts(p, prefix) ? p.slice(prefix.length) : blank(),
        self = this;
      streams.push(
        (async function* () {
          for await (const [k, v] of view.scan(suffix, below, depth + 1)) {
            const full = concat([prefix, k]);
            if (!self.points.has(full)) yield [full, v];
          }
        })(),
      );
    }
    const points = this.points;
    streams.push(
      (async function* () {
        for (const [k, v] of points.entries())
          if (starts(k, p) && !blocked(k) && "value" in v) yield [k, v.value];
      })(),
    );
    // One head per disjoint source; keep early termination/cancellation read-only.
    try {
      const heads: IteratorResult<[Uint8Array, V]>[] = [];
      for (let i = 0; i < streams.length; i += 4)
        heads.push(
          ...(await Promise.all(streams.slice(i, i + 4).map((s) => s.next()))),
        );
      const heap: number[] = [];
      const less = (a: number, b: number) =>
        compare(heads[a].value![0], heads[b].value![0]) < 0;
      const push = (i: number) => {
        heap.push(i);
        let at = heap.length - 1;
        while (at) {
          const parent = (at - 1) >>> 1;
          if (!less(heap[at], heap[parent])) break;
          [heap[at], heap[parent]] = [heap[parent], heap[at]];
          at = parent;
        }
      };
      const pop = () => {
        const first = heap[0],
          last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          let at = 0;
          for (;;) {
            let child = at * 2 + 1;
            if (child >= heap.length) break;
            if (child + 1 < heap.length && less(heap[child + 1], heap[child]))
              child++;
            if (!less(heap[child], heap[at])) break;
            [heap[at], heap[child]] = [heap[child], heap[at]];
            at = child;
          }
        }
        return first;
      };
      for (let i = 0; i < heads.length; i++) if (!heads[i].done) push(i);
      while (heap.length) {
        const best = pop();
        yield heads[best].value!;
        heads[best] = await streams[best].next();
        if (!heads[best].done) push(best);
      }
    } finally {
      await Promise.all(streams.map((s) => s.return(undefined)));
    }
  }
  entries(
    prefix: Uint8Array | string = new Uint8Array(),
  ): AsyncGenerator<[Uint8Array, V]> {
    return this.scan(key(prefix), []);
  }
  private async *pieces(
    p: Uint8Array,
    excluded: readonly Block[] = [],
    depth = 0,
  ): AsyncGenerator<Piece<V, M>> {
    check(depth < 256, "splice nesting limit");
    if (excluded.some((x) => x.prefix && starts(p, x.key))) return;
    const routes = [...this.routes.entries()],
      points = [...this.points.entries()];
    const ownBlocks: Block[] = [
      ...excluded,
      ...routes.map(([k]) => ({ key: k, prefix: true })),
      ...points.map(([k]) => ({ key: k, prefix: false })),
    ];
    if (this.base) {
      const base = this.base,
        blocks = ownBlocks.map((x) => ({
          ...x,
          key: concat([base.prefix, x.key]),
        }));
      const source =
        "trie" in base
          ? base.trie.pieces(concat([base.prefix, p]), blocks)
          : base.view.pieces(concat([base.prefix, p]), blocks, depth + 1);
      for await (const piece of source)
        yield mapPiece(piece, base.prefix, blank());
    }
    for (const [prefix, view] of routes) {
      if (
        !view ||
        excluded.some((x) => x.prefix && starts(prefix, x.key)) ||
        (!starts(prefix, p) && !starts(p, prefix))
      )
        continue;
      const below = [
        ...excluded,
        ...routes
          .filter(([k]) => k.length > prefix.length && starts(k, prefix))
          .map(([k]) => ({ key: k, prefix: true })),
        ...points.map(([k]) => ({ key: k, prefix: false })),
      ]
        .filter((x) => starts(x.key, prefix))
        .map((x) => ({ ...x, key: x.key.slice(prefix.length) }));
      const suffix = starts(p, prefix) ? p.slice(prefix.length) : blank();
      for await (const piece of view.pieces(suffix, below, depth + 1))
        yield mapPiece(piece, blank(), prefix);
    }
    for (const [k, value] of points)
      if (
        starts(k, p) &&
        !excluded.some((x) =>
          x.prefix ? starts(k, x.key) : compare(k, x.key) === 0,
        ) &&
        "value" in value
      )
        yield { kind: "row", key: k, value: value.value };
  }
  async buildNode() {
    if (summaryReuse(this.consumer) && !this.consumer.trieInlineCost) {
      const pieces: Piece<V, M>[] = [];
      for await (const p of this.pieces(blank())) pieces.push(p);
      return (
        await buildPieces(this.basin, pieces, this.consumer)
      ).materialize();
    }
    const rows: [Uint8Array, V][] = [];
    for await (const row of this.entries()) rows.push(row);
    return Trie.buildNode(this.basin, rows, this.consumer);
  }
  /** Compatible consumers reuse unchanged stored subtrees; others retain flat semantics. */
  async store(): Promise<Trie<V, M>> {
    if (summaryReuse(this.consumer) && !this.consumer.trieInlineCost) {
      const pieces: Piece<V, M>[] = [];
      for await (const p of this.pieces(blank())) pieces.push(p);
      const built = await buildPieces(this.basin, pieces, this.consumer);
      return new Trie(this.basin, await built.seal(), this.consumer);
    }
    const rows: [Uint8Array, V][] = [];
    for await (const row of this.entries()) rows.push(row);
    return Trie.build(this.basin, rows, this.consumer);
  }
  async edit(): Promise<TrieEditor<V, M>> {
    return TrieEditor.load(this);
  }
}
