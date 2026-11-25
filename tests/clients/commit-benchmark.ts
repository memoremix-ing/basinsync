// Commit latency and throughput against VersityGW, for comparing server
// implementations (BASINSYNC_SERVER selects the binary). Prints one JSON line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commit } from "./client";
import { fixture } from "./analogue-fixture";

const sequential = Number(Bun.env.BENCH_SEQUENTIAL ?? 200);
const flows = Number(Bun.env.BENCH_FLOWS ?? 32);
const perFlow = Number(Bun.env.BENCH_PER_FLOW ?? 25);
const blob = new Uint8Array(1024).fill(7);

function summarize(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { n: sorted.length, p50_ms: +at(0.5).toFixed(2), p90_ms: +at(0.9).toFixed(2), p99_ms: +at(0.99).toFixed(2),
           mean_ms: +(sorted.reduce((s, x) => s + x, 0) / sorted.length).toFixed(2) };
}
async function timed(url: string, flow: string, viewpoint: bigint): Promise<number> {
  const started = performance.now();
  const response = await commit(url, flow, blob, viewpoint);
  // Time any success; conformance (201) is the integration suites' job.
  assert(response.ok, `${response.status} ${await response.text()}`);
  return performance.now() - started;
}
function peakRssMiB(pid: number): number | null {
  try { return Math.round(Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) / 1024); }
  catch { return null; }
}

const f = await fixture("commit-benchmark");
try {
  const bucket = await f.bucket();
  const app = await f.server(bucket, { BASINSYNC_BATCH_MAX: "32", BASINSYNC_BATCH_WAIT_MS: "2" });
  for (let v = 0n; v < 10n; v++) await timed(app.url, "warmup", v);
  const serial: number[] = [];
  for (let v = 0n; v < BigInt(sequential); v++) serial.push(await timed(app.url, "serial", v));
  const concurrent: number[] = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: flows }, async (_, i) => {
    for (let v = 0n; v < BigInt(perFlow); v++) concurrent.push(await timed(app.url, `flow-${i}`, v));
  }));
  const seconds = (performance.now() - started) / 1000;
  console.log(JSON.stringify({
    sequential: summarize(serial),
    concurrent: { ...summarize(concurrent), flows, seconds: +seconds.toFixed(2), commits_per_second: +(concurrent.length / seconds).toFixed(1) },
    peak_rss_mib: peakRssMiB(app.process.pid),
  }));
  await f.stop(app.process);
} finally {
  await f.close();
}
