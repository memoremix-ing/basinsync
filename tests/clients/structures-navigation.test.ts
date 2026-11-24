import { test, expect } from "bun:test";
import { Basin, MemoryStorage } from "./structures/core";
import { Vector } from "./structures/vector";
import { type Consumer } from "./structures/trie";
import { resolveOperation } from "./structures/operation";
const seed = new Uint8Array(32).fill(42);
const ranges: Consumer<bigint, [bigint, bigint] | null> = {
  migration: 0,
  empty: null,
  entry: (_key, v) => [v, v],
  combine: (parts) => {
    const present = parts.filter((p): p is [bigint, bigint] => p !== null);
    return present.length ? [present[0][0], present.at(-1)![1]] : null;
  },
};
test("reverse vector searches prune stored summaries and readiness probes perform no I/O", async () => {
  const storage = new MemoryStorage(),
    basin = new Basin(storage, { seed });
  const rows = Array.from(
    { length: 6000 },
    (_, i) => [BigInt(i * 3), BigInt(i * 10)] as [bigint, bigint],
  );
  const stored = await Vector.buildEntries(basin, 18000n, rows, ranges, {
    bits: 4,
  });
  const reader = new Vector(new Basin(storage, { seed }), stored.root, ranges);
  storage.reads = 0;
  const predicate = (v: bigint) => v <= 23456n,
    prune = (s: [bigint, bigint] | null) => s !== null && s[0] <= 23456n;
  const op = reader.findLastOrDefer(predicate, prune);
  expect(typeof op).toBe("function");
  expect(storage.reads).toBe(0);
  expect(await resolveOperation(op)).toEqual([7035n, 23450n]);
  expect(storage.reads).toBeLessThan(10);
  const reads = storage.reads;
  expect(reader.findLastOrDefer(predicate, prune)).toEqual([7035n, 23450n]);
  expect(storage.reads).toBe(reads);
  expect(await reader.findLast(() => false)).toBeUndefined();
  expect(
    await reader.findLast(
      (v) => v === 0n,
      (s) => s !== null && s[0] === 0n,
    ),
  ).toEqual([0n, 0n]);
});
