#!/usr/bin/env bash
# Show a clean room's state: unit, memory, transcript activity, commits, the
# agent's STATUS.md and blockers, recent actions, and recent errors.
#
#   scripts/cleanroom/status.sh [--brief] NAME
set -euo pipefail
brief=0
[ "${1:-}" != --brief ] || { brief=1; shift; }
[ $# -eq 1 ] || { echo "usage: $0 [--brief] NAME" >&2; exit 2; }
run="${CLEANROOM_ROOT:-$HOME/cleanroom}/$1"
[ -d "$run/workspace/.git" ] || { echo "no clean room at $run" >&2; exit 1; }
unit="cleanroom-$1.service"
systemd=""
if command -v systemctl >/dev/null; then
  systemd="$(systemctl --user show "$unit" -p ActiveState -p SubState -p Result \
    -p ExecMainStatus -p MemoryCurrent -p MemoryPeak -p MemoryMax \
    -p ActiveEnterTimestamp 2>/dev/null || true)"
fi
ooms="$(journalctl --user -u "$unit" --no-pager -q 2>/dev/null | grep -ciE 'OOM killer' || true)"
RUN="$run" SYSTEMD="$systemd" OOMS="$ooms" BRIEF="$brief" python3 -I - <<'EOF'
import json, os, subprocess, time
run, brief = os.environ["RUN"], os.environ["BRIEF"] == "1"
ws = f"{run}/workspace"
unit = dict(line.split("=", 1) for line in os.environ["SYSTEMD"].splitlines() if "=" in line)
def size(value):
    try: return f"{int(value) / 2**30:.1f}G"
    except ValueError: return "-"
try: status = json.load(open(f"{run}/status.json"))
except (OSError, ValueError): status = {}
state = status.get("state", "unknown")
if unit.get("ActiveState") in ("active", "activating") and state != "running":
    state = "running"
if state == "running" and unit and unit.get("ActiveState") not in ("active", "activating"):
    state = f"stopped ({unit.get('Result', '?')})"
print(f"state: {state}" + (f", exit {status['exit']}" if "exit" in status else ""))
if unit:
    print(f"unit: {unit.get('ActiveState')}/{unit.get('SubState')} since "
          f"{unit.get('ActiveEnterTimestamp') or '-'}; memory {size(unit.get('MemoryCurrent', ''))}"
          f" (peak {size(unit.get('MemoryPeak', ''))}, cap {size(unit.get('MemoryMax', ''))});"
          f" OOM kills {os.environ['OOMS']}")
limit_words = ("usage limit", "limit reached", "hit your limit", "resets", "quota", "rate limit")
log = status.get("transcript", "")
events, actions, errors, final, retry, limit = 0, [], [], None, None, None
if log and os.path.exists(log):
    idle = time.time() - os.path.getmtime(log)
    for line in open(log, errors="replace"):
        try: event = json.loads(line)
        except ValueError: continue
        if not isinstance(event, dict): continue
        events += 1
        message = event.get("message")
        content = (message.get("content") if isinstance(message, dict) else None) or []
        if not isinstance(content, list): continue
        for part in content:
            if not isinstance(part, dict): continue
            if part.get("type") == "tool_use":
                actions.append(f"{part['name']}: {str(part.get('input'))[:110]}")
            elif part.get("type") == "text" and event.get("type") == "assistant":
                actions.append("says: " + part["text"][:110])
            elif part.get("type") == "tool_result" and part.get("is_error"):
                errors.append(str(part.get("content"))[:160])
        if event.get("type") == "result":
            final = event
            text = str(event.get("result") or "")
            if event.get("is_error") and any(w in text.lower() for w in limit_words):
                limit = event
            actions.append(f"result: {event.get('subtype')} {str(event.get('result'))[:110]}")
        elif event.get("type") == "system" and event.get("subtype") == "api_retry":
            retry = event
        elif event.get("type") == "assistant":
            # Sessions emit a result per turn; only a result after the last turn counts.
            retry, final, limit = None, None, None
    print(f"transcript: {events} events, last write {int(idle // 60)} min ago"
          + ("  <- possible stall" if state == "running" and idle > 1200 else ""))
# Outcome: finished, usage-limit (resume later with run.sh --continue), error,
# throttled (still retrying), or in progress.
text = str((final or {}).get("result") or "")
if state == "running" and not (retry and retry.get("error_status") in (429, 529)):
    outcome = "in progress"
elif limit:
    # Background tasks can append empty results after the limit error.
    outcome = "usage-limit: " + str(limit.get("result"))[:200]
elif final and final.get("is_error"):
    outcome = ("usage-limit: " if any(w in text.lower() for w in limit_words) else "error: ") + text[:200]
elif final:
    outcome = "finished"
elif retry and retry.get("error_status") in (429, 529):
    outcome = f"throttled: retrying after HTTP {retry.get('error_status')} ({retry.get('error')})"
elif retry:
    outcome = f"retrying after HTTP {retry.get('error_status')} ({retry.get('error')})"
else:
    outcome = "in progress" if state == "running" else "ended without a result"
if outcome == "finished" and status.get("exit", 0) != 0:
    outcome = f"error: agent exited with status {status['exit']} after its last result"
print(f"outcome: {outcome}")
open(f"{run}/outcome.txt", "w").write(outcome.split(":")[0] + "\n")
def git(*args):
    return subprocess.run(["git", "-C", ws, *args], capture_output=True, text=True).stdout.strip()
try: kills = open(f"{run}/logs/watchdog.log").read().splitlines()
except OSError: kills = []
if kills: print(f"watchdog: {len(kills)} oversized model-checker kills; last: {kills[-1]}")
print(f"commits: {git('rev-list', '--count', 'HEAD')}; last: {git('log', '-1', '--format=%cr: %s')};"
      f" uncommitted files: {len(git('status', '--short').splitlines())}")
try: notes = open(f"{ws}/STATUS.md").read().splitlines()
except OSError: notes = []
blockers = [line for line in notes if "BLOCKED" in line]
for line in blockers: print(f"BLOCKER: {line.strip()}")
if brief: raise SystemExit
print("--- STATUS.md" if notes else "--- no STATUS.md yet")
print("\n".join(notes[:25]))
print("--- recent actions"); print("\n".join(actions[-10:]) or "(none)")
print("--- recent tool errors"); print("\n".join(errors[-5:]) or "(none)")
EOF
