import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { commit, epilogueStatus } from "./client";

// Safe against other clients advancing the same server. An external winner may
// terminate a server; callers choose whether to restart it for another round.
export async function stress(url: string, flow: string, count = 1025, workers = 16) {
  assert(Number.isSafeInteger(count) && count > 0);
  assert(Number.isSafeInteger(workers) && workers > 0 && workers <= 256);
  const accepted = new Map<bigint, Uint8Array>();
  let issued = 0;
  let conflicts = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (issued < count) {
      const ticket = issued++;
      const blob = new Uint8Array(randomBytes(ticket % 4097));
      for (let attempt = 0; ; attempt++) {
        assert(attempt < 10_000, "contention retry budget exhausted");
        const { latest: before } = await epilogueStatus(url, flow);
        const viewpoint = before ? BigInt(before.viewpoint) + 1n : 0n;
        const response = await commit(url, flow, blob, viewpoint);
        if (response.status === 409) { await response.arrayBuffer(); conflicts++; continue; }
        assert.equal(response.status, 201, await response.text());
        assert(!accepted.has(viewpoint), "duplicate successful viewpoint");
        accepted.set(viewpoint, blob);
        break;
      }
    }
  }));
  const { latest: end } = await epilogueStatus(url, flow);
  assert(end);
  console.log(`put of success: ${accepted.size} commits, ${conflicts} stale requests rejected, latest ${end.viewpoint}`);
  return accepted;
}

if (import.meta.main) {
  await stress(process.argv[2] ?? "http://127.0.0.1:3000", process.argv[3] ?? "default", Number(process.argv[4] ?? 1025), Number(process.argv[5] ?? 16));
}
