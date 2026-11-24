import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  VectorMap,
  type VectorMutationMetrics,
} from "./structures/logical-vector";
const n = 100000,
  edits = 16384,
  rows = Array.from({ length: n }, (_, i) => [BigInt(i), i] as const),
  samples: any[] = [];
for (const bits of [5, 7]) {
  const base = VectorMap.from(BigInt(n), rows, bits);
  for (let trial = 0; trial < 5; trial++)
    for (const batch of [1, 64, 1024])
      for (const mode of trial % 2
        ? ["owned", "persistent"]
        : ["persistent", "owned"]) {
        let map = base;
        const metrics: VectorMutationMetrics = {
            copiedNodes: 0,
            slotsCopied: 0,
            writes: 0,
            snapshots: 0,
          },
          at = performance.now();
        for (let start = 0; start < edits; start += batch) {
          const scope = mode === "owned" ? map.mutate(metrics) : undefined;
          for (let j = 0; j < batch; j++) {
            const i = BigInt(((start / batch) * 7919 + (j % 8)) % n);
            if (scope) scope.set(i, -(start + j));
            else map = map.set(i, -(start + j));
          }
          if (scope) map = scope.finish();
        }
        const ms = performance.now() - at;
        assert.equal(base.get(7919n), 7919);
        assert.equal(map.size, n);
        samples.push({
          trial,
          bits,
          batch,
          mode,
          ms,
          metrics: mode === "owned" ? metrics : undefined,
        });
      }
}
writeFileSync(
  ".local/vector-owned.json",
  JSON.stringify(
    {
      runtime: Bun.version,
      n,
      edits,
      method:
        "5 alternating trials; fixed-size persistent replacements, 8 neighboring slots per burst; snapshot per batch; no crypto/aggregation/storage/export",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log("vector mutation measurements complete");
