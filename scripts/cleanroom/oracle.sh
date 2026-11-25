#!/usr/bin/env bash
# Run a hidden oracle against a finished clean room. The clean room's oracle
# CLI (oracle-interface.md) runs inside the same sandbox as the agent did; it
# only ever sees requests, never this repository's expected results.
#
#   scripts/cleanroom/oracle.sh vectors [--cli 'CMD'] NAME
#   scripts/cleanroom/oracle.sh integration [--server 'CMD'] [SUITE...] NAME
#
# vectors: CMD runs from the clean room's workspace and is remembered in
# eval/cli, e.g. 'cargo run -q --release -p some-cli'.
# integration: CMD builds the clean room's server and prints its path
# (remembered in eval/server); eval/server-env maps its variable names to
# ours as THEIRS=OURS lines. Each suite (default: all) runs in a sandbox that
# can read this repository but write only under eval/.
set -euo pipefail
HOME_SAVE="$HOME"
mode="${1:-}"; shift || true
case "$mode" in vectors|integration) ;; *) sed -n '5,15p' "$0" >&2; exit 2 ;; esac
if [ "$mode" = integration ]; then
  server=""
  [ "${1:-}" != --server ] || { server="$2"; shift 2; }
  [ $# -ge 1 ] || { sed -n '5,15p' "$0" >&2; exit 2; }
  name="${!#}"; suites=("${@:1:$#-1}")
  here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
  run="${CLEANROOM_ROOT:-$HOME/cleanroom}/$name"; eval_dir="$run/eval"
  mkdir -p "$eval_dir/integration/tmp"
  [ -z "$server" ] || printf '%s\n' "$server" > "$eval_dir/server"
  [ -s "$eval_dir/server" ] || { echo "no server build recorded; pass --server 'CMD'" >&2; exit 1; }
  [ -f "$eval_dir/server-env" ] || { echo "write $eval_dir/server-env (THEIRS=OURS lines)" >&2; exit 1; }
  "$here/run.sh" --foreground --command "( $(cat "$eval_dir/server") ) > '$eval_dir/server-path'" "$name" >/dev/null
  bin="$(tail -1 "$eval_dir/server-path")"
  [ -x "$bin" ] || { echo "server build did not print an executable path: $bin" >&2; exit 1; }
  [ ${#suites[@]} -gt 0 ] || suites=(integration cancellation-integration analogue-integration
    bidirectional-integration crc32c-integration kernel-backup-integration
    kernel-promotion-integration observability-integration)
  # The suites write artifacts under their root's .local; srt will not grant
  # writes inside this repository, so run them from a fresh copy in eval/.
  copy="$eval_dir/integration/root"
  rm -rf "$copy"; mkdir -p "$copy/tests" "$copy/.local"
  cp -r "$repo/tests/clients" "$repo/tests/vectors" "$copy/tests/"
  cp "$repo/package.json" "$copy/"
  ln -s "$repo/node_modules" "$copy/node_modules"; ln -s "$repo/target" "$copy/target"
  ln -s "$repo/.local/bin" "$copy/.local/bin"
  settings="$eval_dir/integration/srt-settings.json"
  HOME_DIR="$HOME" REPO="$repo" RUN="$run" python3 -I - > "$settings" <<'PY'
import json, os
home, repo, run = os.environ["HOME_DIR"], os.environ["REPO"], os.environ["RUN"]
print(json.dumps({
    "filesystem": {
        "denyRead": ["/home", "/root", "/run/user", f"/tmp/claude-{os.getuid()}"],
        "allowRead": [repo, f"{run}/workspace/target", f"{run}/eval"]
                     + [f"{home}/{p}" for p in (".bun/bin", ".local/bin", ".local/node")],
        "allowWrite": [f"{run}/eval"],
        "denyWrite": [],
    },
    "network": {"allowedDomains": [], "deniedDomains": [], "allowAllUnixSockets": True,
                "allowLocalBinding": True},
}, indent=2))
PY
  failed=0
  # One sandboxed bun process for a suite; extra NAME=VALUE arguments set env.
  run_bun() {
    local suite="$1" limit="$2"; shift 2
    ( cd "$copy"
      for variable in $(compgen -e); do unset "$variable" 2>/dev/null || true; done
      export PATH="$HOME_SAVE/.local/bin:$HOME_SAVE/.bun/bin:/usr/bin:/bin" HOME="$HOME_SAVE" \
        TMPDIR="$eval_dir/integration/tmp" CLAUDE_CODE_TMPDIR="$eval_dir/integration/tmp" \
        BASINSYNC_SERVER="$here/oracles/server-adapter.sh" \
        CLEANROOM_SERVER_BIN="$bin" CLEANROOM_SERVER_ENV_MAP="$eval_dir/server-env" "$@"
      exec timeout --kill-after=30 "$limit" srt --settings "$settings" bun "tests/clients/$suite.ts" ) < /dev/null
  }
  for suite in "${suites[@]}"; do
    log="$eval_dir/integration/$suite.log"
    if grep -q 'await scenario(' "$repo/tests/clients/$suite.ts"; then
      # Scenario suites run each scenario in its own process, so a crash or
      # hang costs exactly that scenario.
      run_bun "$suite" 300 BASINSYNC_SCENARIO_LIST=1 > "$log.list" 2>&1 || true
      : > "$log"; code=0
      while read -r _ n rest; do
        if run_bun "$suite" "${CLEANROOM_SCENARIO_TIMEOUT:-300}" BASINSYNC_SCENARIO="$n" > "$log.$n" 2>&1; then status=0; else status=$?; fi
        if ! grep -qE '^(PASS|FAIL) \[' "$log.$n"; then
          reason=$([ "$status" -eq 124 ] || [ "$status" -eq 137 ] && echo "timed out" || echo "exited $status")
          printf 'FAIL %s (%s outside the scenario: %s)\n' "$rest" "$reason" \
            "$(grep -m1 -E 'Error|error:' "$log.$n" | cut -c1-120)" >> "$log.$n"
        fi
        cat "$log.$n" >> "$log"
      done < <(grep '^SCENARIO ' "$log.list")
      grep -q '^FAIL \[' "$log" && code=1
    else
      if run_bun "$suite" "${CLEANROOM_SUITE_TIMEOUT:-900}" > "$log" 2>&1; then code=0; else code=$?; fi
    fi
    passes=$(grep -c '^PASS \[' "$log" || true); fails=$(grep -c '^FAIL \[' "$log" || true)
    if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then verdict="HANG after ${CLEANROOM_SUITE_TIMEOUT:-900}s"
    elif [ "$code" -eq 0 ]; then verdict="ok"
    else verdict="exit $code"; fi
    printf '%-28s %3s pass %3s fail  %s\n' "$suite" "$passes" "$fails" "$verdict"
    grep -E '^FAIL \[' "$log" | sed 's/^/    /' | cut -c1-150 || true
    if [ "$code" -ne 0 ] && [ "$fails" -eq 0 ]; then
      echo "    stopped outside a scenario: $(grep -m1 -E 'Error|error:' "$log" | cut -c1-140)"
    fi
  done | tee "$eval_dir/integration/report.txt"
  # Scenario totals by tutorial tag, across suites.
  cat "$eval_dir"/integration/*.log | grep -oE '^(PASS|FAIL) \[[^]]*\]' | sort | uniq -c |
    awk '{tag=$3; for(i=4;i<=NF;i++) tag=tag" "$i; n[tag" "$2]=$1; tags[tag]=1}
         END{for(t in tags) printf "  %-32s %3d pass %3d fail\n", t, n[t" PASS"], n[t" FAIL"]}' |
    sort | tee -a "$eval_dir/integration/report.txt"
  # Every stored message the suites left behind, against the docs' CDDL schemas.
  # Test fixtures add a few deliberate failures; compare with the reference.
  cargo build -q --manifest-path "$repo/Cargo.toml" --example schema-check
  { echo "--- stored messages vs docs/ CDDL schemas"
    "$repo/target/debug/examples/schema-check" "$repo/docs" "$copy/.local" || true
  } | tee -a "$eval_dir/integration/report.txt"
  exit 0
fi
cli=""
[ "${1:-}" != --cli ] || { cli="$2"; shift 2; }
[ $# -eq 1 ] || { sed -n '5,9p' "$0" >&2; exit 2; }
name="$1" here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
eval_dir="${CLEANROOM_ROOT:-$HOME/cleanroom}/$name/eval"
mkdir -p "$eval_dir/vectors"
[ -z "$cli" ] || printf '%s\n' "$cli" > "$eval_dir/cli"
[ -s "$eval_dir/cli" ] || { echo "no oracle CLI recorded; pass --cli 'CMD'" >&2; exit 1; }
python3 -I "$here/oracles/vectors.py" make "$repo" "$eval_dir/vectors"
rm -f "$eval_dir/vectors/responses.jsonl"
"$here/run.sh" --foreground --command \
  "( $(cat "$eval_dir/cli") ) < '$eval_dir/vectors/requests.jsonl' > '$eval_dir/vectors/responses.jsonl'" \
  "$name" >/dev/null
python3 -I "$here/oracles/vectors.py" check "$eval_dir/vectors" | tee "$eval_dir/vectors/report.txt"
