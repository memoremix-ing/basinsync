/** Prove format-preserving vector changes with independent old/new readers. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import * as core from "../clients/structures/core";
import { Vector } from "../clients/structures/vector";
const root = resolve(Bun.env.VECTOR_PASS_ROOT ?? ".local/vector-pass");
const oldCore = await import(`${root}/baseline/clients/structures/core.ts`),
  oldVector = (await import(`${root}/baseline/clients/structures/vector.ts`))
    .Vector;
const consumer = {
  migration: 7,
  empty: 0n,
  entry: () => 1n,
  combine: (s: readonly bigint[]) => s.reduce((a, b) => a + b, 0n),
};
let graphs = 0,
  reads = 0;
const roots: any[] = [];
for (const start of [0n, 1n << 200n])
  for (const n of [
    0, 1, 31, 32, 33, 255, 256, 1024, 1280, 1281, 4096, 100000,
  ]) {
    const rows = Array.from({ length: n }, (_, i) => [
      start + BigInt(i),
      i % 7 ? i : null,
    ]);
    const a = new oldCore.Basin(new oldCore.MemoryStorage(), {
        seed: new Uint8Array(32).fill(42),
      }),
      b = new core.Basin(new core.MemoryStorage(), {
        seed: new Uint8Array(32).fill(42),
      }),
      length = start + BigInt(n);
    const before = await oldVector.buildEntries(a, length, rows, consumer),
      after = await Vector.buildEntries(
        b,
        length,
        rows as [bigint, number | null][],
        consumer,
      );
    assert.equal(
      core.hex(before.root[6].sha384),
      core.hex(after.root[6].sha384),
    );
    const oldObjects = [...a.storage.objects.values()].map((v: any) =>
        Buffer.from(v.bytes),
      ),
      newObjects = [...(b.storage as core.MemoryStorage).objects.values()].map(
        (v) => Buffer.from(v.bytes),
      );
    assert.deepEqual(oldObjects, newObjects);
    const readers = [
      new oldVector(a, after.root, consumer),
      new Vector(b, before.root, consumer),
    ];
    for (const reader of readers) {
      for (const i of new Set(
        [0, 1, 30, 31, 32, 254, 255, 256, n - 1].filter((i) => i >= 0 && i < n),
      )) {
        assert.equal(await reader.get(start + BigInt(i)), i % 7 ? i : null);
        reads++;
      }
      assert.equal(await reader.get(length), undefined);
      reads++;
    }
    roots.push({
      start: String(start),
      n,
      sha384: core.hex(after.root[6].sha384),
      objects: newObjects.length,
    });
    graphs += 2;
  }
console.log(
  JSON.stringify(
    { graphs, cross_reads: reads, byte_identical: true, roots },
    null,
    2,
  ),
);
