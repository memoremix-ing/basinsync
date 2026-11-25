#!/usr/bin/env bash
# Block until a clean-room run finishes, printing a brief status every
# interval. Agents should call this right after run.sh and keep calling it
# while it exits 3, so they never end a turn with a run still in flight.
#
#   scripts/cleanroom/wait.sh [--timeout SECONDS] [--interval SECONDS] NAME
#
# Exit status: 0 the agent finished cleanly; 1 it failed or was stopped;
# 3 still running when the timeout elapsed (default 6600 s, under the usual
# two-hour limit on an agent's tool call); 4 it stopped on a usage limit, so
# resume it with `run.sh --continue NAME` once the allowance resets.
set -euo pipefail
timeout=6600 interval=300
while [ $# -gt 1 ]; do
  case "$1" in
    --timeout) timeout="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    *) break ;;
  esac
done
[ $# -eq 1 ] || { echo "usage: $0 [--timeout S] [--interval S] NAME" >&2; exit 2; }
name="$1" here="$(dirname "$0")"
run="${CLEANROOM_ROOT:-$HOME/cleanroom}/$name"
unit="cleanroom-$name.service"
deadline=$(( $(date +%s) + timeout )) next=0
while :; do
  active=0 known=0
  if command -v systemctl >/dev/null; then
    systemctl --user is-active --quiet "$unit" && active=1
    [ "$(systemctl --user show "$unit" -p LoadState --value 2>/dev/null)" = loaded ] && known=1
  fi
  read -r state pid < <(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("state",""), d.get("pid",0))' \
    "$run/status.json" 2>/dev/null || echo "none 0")
  if [ "$active" -eq 0 ]; then
    # Foreground runs have no unit; fall back to the recorded process.
    if [ "$state" != running ] || [ "$known" -eq 1 ] || ! kill -0 "$pid" 2>/dev/null; then
      "$here/status.sh" "$name"
      case "$(cat "$run/outcome.txt" 2>/dev/null)" in
        finished) exit 0 ;;
        usage-limit) echo "paused by a usage limit; resume with run.sh --continue $name"; exit 4 ;;
        *) exit 1 ;;
      esac
    fi
  fi
  now=$(date +%s)
  if [ "$now" -ge "$next" ]; then
    echo "== $(date -u +%H:%M:%SZ)"; "$here/status.sh" --brief "$name"; next=$(( now + interval ))
  fi
  if [ "$now" -ge "$deadline" ]; then
    echo "still running; call wait.sh $name again"; exit 3
  fi
  sleep 30
done
