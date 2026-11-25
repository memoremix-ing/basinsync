// Independent scenarios: one failure is recorded and the suite moves on, so a
// missing feature fails only its own scenarios. Tags name the tutorial that
// introduced the behavior, letting reports separate skipped scope from bugs.
type Outcome = { tag: string; label: string; ok: boolean; error?: string };
const outcomes: Outcome[] = [];

// A failed scenario can leave requests in flight; when its processes are torn
// down they reject with nobody awaiting them, which would otherwise end the
// whole suite. Record such strays against the scenario that was running.
let current = "(setup)";
const strays: string[] = [];
const stray = (kind: string) => (reason: unknown) => {
  const text = reason instanceof Error ? reason.message : String(reason);
  const where = reason instanceof Error ? reason.stack?.split("\n").find(line => line.includes("/tests/clients/")) : undefined;
  strays.push(`${current}: ${kind}: ${text}`);
  console.log(`STRAY [${current}] ${kind}: ${text.split("\n")[0]}`);
  for (const line of [...text.split("\n").slice(1, 12), ...(where ? [where.trim()] : [])]) console.log(`  ${line}`);
  // Outside any scenario (suites that only report progress markers), a stray
  // means the suite itself broke; without this it could still exit 0.
  if (current === "(setup)" && outcomes.length === 0) process.exitCode = 1;
};
process.on("unhandledRejection", stray("unhandled rejection"));
process.on("uncaughtException", stray("uncaught exception"));

// BASINSYNC_SCENARIO_LIST=1 lists scenarios without running them;
// BASINSYNC_SCENARIO=<n> runs only the nth, so callers can isolate each one in
// its own process (a crash then costs exactly one scenario).
const only = Bun.env.BASINSYNC_SCENARIO === undefined ? undefined : Number(Bun.env.BASINSYNC_SCENARIO);
const listing = Bun.env.BASINSYNC_SCENARIO_LIST === "1";
let index = 0;
let active = false;

export async function scenario(tag: string, label: string, run: () => Promise<void>): Promise<void> {
  const n = index++;
  if (listing) { console.log(`SCENARIO ${n} [${tag}] ${label}`); return; }
  if (only !== undefined && n !== only) return;
  current = label; active = true;
  try {
    await run();
    outcomes.push({ tag, label, ok: true });
    console.log(`PASS [${tag}] ${label}`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    outcomes.push({ tag, label, ok: false, error: message.split("\n").slice(0, 3).join(" | ") });
    console.log(`FAIL [${tag}] ${label}\n  ${message.split("\n").slice(0, 6).join("\n  ")}`);
  } finally { active = false; }
}

/** Record shared, unscoped setup that ran to completion as a passing scenario. */
export function passed(tag: string, label: string): void {
  // In single-scenario runs, only markers inside the selected scenario count.
  if (listing || (only !== undefined && !active)) return;
  outcomes.push({ tag, label, ok: true });
  console.log(`PASS [${tag}] ${label}`);
}

/** Print a machine-readable summary; returns false if any scenario failed. */
export function report(): boolean {
  const failed = outcomes.filter((o) => !o.ok).length;
  console.log(`SCENARIOS ${JSON.stringify({ passed: outcomes.length - failed, failed, strays: strays.length, outcomes })}`);
  return failed === 0;
}
