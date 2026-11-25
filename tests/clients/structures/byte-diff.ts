/** Hash-pruned ordered byte diff, shared by trie and treelist adapters. */
import { localByteDiff } from "./local-byte-diff";
import { check } from "./core";
export type ByteEdit = { before: { start: bigint; length: bigint }; after: { start: bigint; length: bigint } };
export type SequenceNode = { size: bigint; uniform?: number; identity?: string; rank: number; expand(): Promise<SequenceNode[]> };
export type ByteSequence = { root: SequenceNode; read(start: bigint, length: number): Promise<Uint8Array> };
type Span = { d: SequenceNode; at: bigint };
const same = (a: SequenceNode, b: SequenceNode) => a.identity !== undefined && a.identity === b.identity && a.size === b.size;
export async function diffBytes(before: ByteSequence, after: ByteSequence, refineBytes = 65536, localBytes = 262144): Promise<ByteEdit[]> {
  check(Number.isSafeInteger(refineBytes) && refineBytes >= 0 && refineBytes <= 32 * 1024 * 1024, "invalid diff refinement window");
  check(Number.isSafeInteger(localBytes) && localBytes >= 0 && localBytes <= 1048576, "invalid local diff budget");
  if (same(before.root, after.root)) return [];
  if (before.root.uniform !== undefined) {
    const run = await uniformDiff(before, after);
    if (run) return run;
  } else if (after.root.uniform !== undefined) {
    const run = await uniformDiff(after, before);
    if (run) return run.map(e => ({ before: e.after, after: e.before }));
  }
    let active = 0; const waiting: (() => void)[] = [];
    const bounded = async <T>(f: () => Promise<T>) => {
      if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve)); else active++;
      try { return await f(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
    };
    const edits: ByteEdit[] = [];
    const total = (a: Span[]) => a.reduce((n, x) => n + x.d.size, 0n);
    const expand = async (file: ByteSequence, spans: Span[], depth: number) => {
      const groups = await Promise.all(spans.map(async span => {
        if (span.d.rank !== depth) return [span];
        let at = span.at; const out: Span[] = [];
        for (const d of await bounded(() => span.d.expand())) { out.push({ d, at }); at += d.size; }
        check(at === span.at + span.d.size, "sequence child sizes do not match parent");
        return out;
      }));
      const out = groups.flat();
      return out;
    };
    const emit = (a: Span[], b: Span[], oldAt: bigint, newAt: bigint) => { edits.push({ before: { start: a[0]?.at ?? oldAt, length: total(a) }, after: { start: b[0]?.at ?? newAt, length: total(b) } }); };
    const walk = async (a: Span[], b: Span[], oldAt: bigint, newAt: bigint): Promise<void> => {
      const normalize = (x: Span): Span => x.d.uniform === undefined ? x : { ...x, d: { ...x.d, rank: 0, identity: `uniform/${x.d.uniform}` } };
      a = a.map(normalize); b = b.map(normalize);
      let ai = 0, bi = 0, ae = a.length, be = b.length;
      while (ai < ae && bi < be) {
        const x = a[ai], y = b[bi];
        if (!same(x.d, y.d) && !(x.d.uniform !== undefined && x.d.uniform === y.d.uniform)) break;
        const n = x.d.size < y.d.size ? x.d.size : y.d.size;
        oldAt = x.at + n; newAt = y.at + n;
        if (n === x.d.size) ai++; else a[ai] = { at: x.at + n, d: { ...x.d, size: x.d.size - n } };
        if (n === y.d.size) bi++; else b[bi] = { at: y.at + n, d: { ...y.d, size: y.d.size - n } };
      }
      while (ae > ai && be > bi) {
        const x = a[ae - 1], y = b[be - 1];
        if (!same(x.d, y.d) && !(x.d.uniform !== undefined && x.d.uniform === y.d.uniform)) break;
        const n = x.d.size < y.d.size ? x.d.size : y.d.size;
        if (n === x.d.size) ae--; else a[ae - 1] = { ...x, d: { ...x.d, size: x.d.size - n } };
        if (n === y.d.size) be--; else b[be - 1] = { ...y, d: { ...y.d, size: y.d.size - n } };
      }
      a = a.slice(ai, ae); b = b.slice(bi, be);
      if (!a.length && !b.length) return;
      if (!a.length || !b.length) { emit(a, b, oldAt, newAt); return; }
      const anchors = common(a, b);
      if (anchors.length) {
        let ai = 0, bi = 0;
        for (const [i, j] of anchors) {
          await walk(a.slice(ai, i), b.slice(bi, j), oldAt, newAt);
          oldAt = a[i].at + a[i].d.size; newAt = b[j].at + b[j].d.size; ai = i + 1; bi = j + 1;
        }
        await walk(a.slice(ai), b.slice(bi), oldAt, newAt); return;
      }
      const depth = [...a, ...b].reduce((n, x) => Math.max(n, x.d.rank), 0);
      if (!depth) { emit(a, b, oldAt, newAt); return; }
      const [left, right] = await Promise.all([expand(before, a, depth), expand(after, b, depth)]);
      await walk(left, right, oldAt, newAt);
    };
    await walk([{ d: before.root, at: 0n }], [{ d: after.root, at: 0n }], 0n, 0n);
    const refined: ByteEdit[] = [];
    for (const edit of edits) {
      let { start: a, length: al } = edit.before, { start: b, length: bl } = edit.after;
      // Bound working memory, not patch quality: shifted low-entropy content
      // may lack anchors yet still have a long equal suffix. Read windows until
      // a difference, reusing the ordinary immutable node cache.
      if (refineBytes) {
        while (al && bl) {
          const n = Number(al < bl ? al : bl), take = Math.min(refineBytes, n);
          const [left, right] = await Promise.all([before.read(a, take), after.read(b, take)]);
          let prefix = 0; while (prefix < take && left[prefix] === right[prefix]) prefix++;
          a += BigInt(prefix); b += BigInt(prefix); al -= BigInt(prefix); bl -= BigInt(prefix);
          if (prefix < take) break;
        }
        while (al && bl) {
          const take = Math.min(refineBytes, Number(al < bl ? al : bl));
          const [left, right] = await Promise.all([before.read(a + al - BigInt(take), take), after.read(b + bl - BigInt(take), take)]);
          let suffix = 0; while (suffix < take && left[take - 1 - suffix] === right[take - 1 - suffix]) suffix++;
          al -= BigInt(suffix); bl -= BigInt(suffix);
          if (suffix < take) break;
        }
      }
      // Losing structural anchors must not turn sparse overwrites into one
      // enormous patch. Equal-length gaps can be compared in bounded windows.
      if (al && al === bl && al + bl > BigInt(localBytes) && localBytes >= 2) {
        const window = Math.min(65536, Math.floor(localBytes / 2));
        for (let offset = 0n; offset < al; offset += BigInt(window)) {
          const n = Number(al - offset < BigInt(window) ? al - offset : BigInt(window));
          const [left, right] = await Promise.all([before.read(a + offset, n), after.read(b + offset, n)]);
          const small = localByteDiff(left, right);
          if (small) refined.push(...small.map(e => ({ before: { start: a + offset + e.before.start, length: e.before.length }, after: { start: b + offset + e.after.start, length: e.after.length } })));
          else refined.push({ before: { start: a + offset, length: BigInt(n) }, after: { start: b + offset, length: BigInt(n) } });
        }
        continue;
      }
      if (al && bl && al + bl <= BigInt(localBytes)) {
        const small = localByteDiff(await before.read(a, Number(al)), await after.read(b, Number(bl)));
        if (small) {
          refined.push(...small.map(e => ({ before: { start: a + e.before.start, length: e.before.length }, after: { start: b + e.after.start, length: e.after.length } })));
          continue;
        }
      }
      if (al || bl) refined.push({ before: { start: a, length: al }, after: { start: b, length: bl } });
    }
    return refined;
}

/** Unique content anchors, then LIS to retain order without quadratic LCS. */
function common(a: Span[], b: Span[]): [number, number][] {
  const index = (rows: Span[]) => { const m = new Map<string, number>(); rows.forEach((x, i) => { const k = x.d.identity; if (k === undefined) return; m.set(k, m.has(k) ? -1 : i); }); return m; };
  const left = index(a), right = index(b), pairs: [number, number][] = [];
  a.forEach((x, i) => { const k = x.d.identity; if (k === undefined) return; const j = right.get(k); if (left.get(k) === i && j !== undefined && j >= 0) pairs.push([i, j]); });
  const tails: number[] = [], previous = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pairs[tails[mid]][1] < pair[1]) lo = mid + 1; else hi = mid; }
    if (lo) previous[i] = tails[lo - 1]; tails[lo] = i;
  });
  const out: [number, number][] = []; let i = tails.at(-1) ?? -1;
  while (i >= 0) { out.push(pairs[i]); i = previous[i]; }
  return out.reverse();
}

/** An all-one-byte side is an RLE sequence, not an ambiguous repeated hash.
 * Match its byte budget against equal runs; fetch only mixed leaves. */
async function uniformDiff(before: ByteSequence, after: ByteSequence): Promise<ByteEdit[] | null> {
  const byte = before.root.uniform!;
  const runs: { at: bigint; size: bigint; equal: boolean }[] = [];
  const add = (at: bigint, size: bigint, equal: boolean) => {
    if (!size) return;
    const last = runs.at(-1);
    if (last && last.equal === equal && last.at + last.size === at) last.size += size;
    else runs.push({ at, size, equal });
  };
  const visit = async (d: SequenceNode, at: bigint): Promise<boolean> => {
    if (d.uniform !== undefined) { add(at, d.size, d.uniform === byte); return runs.length <= 8192; }
    if (d.rank) {
      const children = await d.expand(); let cursor = at;
      for (const child of children) { if (!await visit(child, cursor)) return false; cursor += child.size; }
      check(cursor === at + d.size, "sequence child sizes do not match parent");
    } else {
      for (let offset = 0n; offset < d.size; offset += 65536n) {
        const bytes = await after.read(at + offset, Number(d.size - offset < 65536n ? d.size - offset : 65536n));
        let start = 0;
        for (let i = 1; i <= bytes.length; i++) if (i === bytes.length || (bytes[i] === byte) !== (bytes[start] === byte)) {
          add(at + offset + BigInt(start), BigInt(i - start), bytes[start] === byte); start = i;
          if (runs.length > 8192) return false;
        }
      }
    }
    return true;
  };
  if (!await visit(after.root, 0n)) return null;
  const matching = runs.reduce((n, r) => n + (r.equal ? r.size : 0n), 0n);
  let remove = before.root.size > matching ? before.root.size - matching : 0n, cursor = 0n;
  const edits: ByteEdit[] = [];
  for (const run of runs) {
    if (run.equal) {
      const available = before.root.size - cursor, kept = available < run.size ? available : run.size;
      cursor += kept;
      if (kept < run.size) edits.push({ before: { start: cursor, length: 0n }, after: { start: run.at + kept, length: run.size - kept } });
    } else {
      const available = before.root.size - cursor;
      const erased = remove < run.size ? remove : run.size, count = erased < available ? erased : available;
      edits.push({ before: { start: cursor, length: count }, after: { start: run.at, length: run.size } });
      cursor += count; remove -= count;
    }
  }
  if (cursor < before.root.size) edits.push({ before: { start: cursor, length: before.root.size - cursor }, after: { start: after.root.size, length: 0n } });
  return edits;
}
