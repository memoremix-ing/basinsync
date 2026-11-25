import { test, expect } from "bun:test";
import { sectors } from "./structures/volume";
test("sector size aggregates blob bytes without keys or envelopes", async () => {
  expect(sectors.empty.size).toBe(0n);
  const parts = await Promise.all([0, 3, 9].map(n => sectors.entry(new Uint8Array([1]), [new Uint8Array(n)])));
  expect((await sectors.combine(parts)).size).toBe(12n);
});
