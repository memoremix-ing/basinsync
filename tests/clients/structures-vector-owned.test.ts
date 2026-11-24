import { test, expect } from "bun:test";
import { VectorMap } from "./structures/logical-vector";
import { VectorEditor } from "./structures/vector";
import { Basin, MemoryStorage } from "./structures/core";
import { plain } from "./structures/trie";
test("owned vector writes reuse branches but snapshots and iterators rotate ownership", () => {
  for (const bits of [1, 5, 7, 8]) {
    const base = VectorMap.from(
        5000n,
        Array.from({ length: 5000 }, (_, i) => [BigInt(i), i] as const),
        bits,
      ),
      s = base.mutate();
    for (let i = 0; i < 1000; i++) s.set(2000n, -i);
    expect(base.get(2000n)).toBe(2000);
    const a = s.snapshot(),
      iter = s.entries();
    s.set(2000n, 42);
    s.delete(1999n);
    s.push(99);
    const b = s.finish();
    expect(a.get(2000n)).toBe(-999);
    expect(a.has(1999n)).toBe(true);
    expect(a.length).toBe(5000n);
    expect([...iter].find(([i]) => i === 2000n)![1]).toBe(-999);
    expect(b.get(2000n)).toBe(42);
    expect(b.has(1999n)).toBe(false);
    expect(b.get(5000n)).toBe(99);
    expect(() => s.set(0n, 0)).toThrow();
  }
});
test("vector transients preserve independent sparse Map state across resizing and snapshots", () => {
  let length = 100n;
  const expected = new Map<bigint, number | undefined>();
  const base = VectorMap.from<number | undefined>(length, []), s = base.mutate(), other = base.mutate();
  const rows = () => [...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let x = 71;
  for (let i = 0; i < 3000; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const n = BigInt(x % 200);
    if (i % 13 === 0) {
      length = n;
      for (const k of expected.keys()) if (k >= length) expected.delete(k);
      s.resize(n);
    } else if (length) {
      const at = n % length;
      if (i % 3) {
        expected.set(at, i % 5 ? i : undefined);
        s.set(at, i % 5 ? i : undefined);
      } else {
        expected.delete(at);
        s.delete(at);
      }
    }
    if (i % 97 === 0)
      expect([...s.snapshot().entries()]).toEqual(rows());
  }
  const final = s.finish();
  expect([...final.entries()]).toEqual(rows());
  expect(final.length).toBe(length);
  expect(other.finish().size).toBe(0);
  const bad = final.mutate();
  expect(() => bad.set(-1n, 1)).toThrow();
  expect(() => bad.snapshot()).toThrow();
});
test("vector editor scopes export canonical snapshots", async () => {
  const b = new Basin(new MemoryStorage(), {
      seed: new Uint8Array(32).fill(42),
    }),
    base = VectorEditor.from(
      b,
      5000n,
      Array.from({ length: 5000 }, (_, i) => [BigInt(i), i] as const),
      plain,
      { bits: 7 },
    );
  const scope = base.mutate();
  scope.set(2345n, -1);
  const held = scope.snapshot();
  scope.set(2345n, -2);
  const end = scope.finish();
  expect(held.get(2345n)).toBe(-1);
  expect(base.get(2345n)).toBe(2345);
  expect(await (await end.store()).get(2345n)).toBe(-2);
  const canonical = await base.set(2345n, -2).store();
  expect((await end.store()).root[6].sha384).toEqual(canonical.root[6].sha384);
});
