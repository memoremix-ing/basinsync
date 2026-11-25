#!/usr/bin/env bash
# Run an agent inside a clean room created by setup.sh, sandboxed with srt.
#
#   scripts/cleanroom/run.sh [--agent claude|codex] [--model M] [--memory SIZE]
#                            [--check] [--continue] [--foreground] NAME
#   scripts/cleanroom/run.sh --command 'CMD' NAME
#
# Runs start detached in their own systemd user unit, cleanroom-NAME, capped at
# SIZE of memory (default 40% of RAM, no swap); an out-of-memory kill takes the
# offending process, not the agent or the rest of the machine. Whoever starts a
# run must then wait for it with wait.sh and report the outcome; status.sh
# shows progress, memory, recent actions, errors, and the agent's STATUS.md.
#
# The sandbox can read and write only the workspace, the agent's own config
# home, its TMPDIR, and the Quint cache; toolchains are read-only; everything
# else under $HOME, and this user's Claude scratch space under /tmp, is hidden.
# Network is limited to the agent's API, package registries, and tool docs.
# Every run first probes the sandbox and refuses to start if a check fails.
#
# Credentials are passed through the environment, never copied from your own
# agent config: claude needs CLAUDE_CODE_OAUTH_TOKEN (from `claude
# setup-token`) or ANTHROPIC_API_KEY; codex needs OPENAI_API_KEY.
set -euo pipefail

agent=claude model="${CLEANROOM_MODEL:-}" memory="${CLEANROOM_MEMORY_MAX:-}"
check_only=0 resume=0 command="" foreground=0 inside=0 args=("$@")
while [ $# -gt 1 ]; do
  case "$1" in
    --agent) agent="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    --command) agent=custom command="$2"; shift 2 ;;
    --check) check_only=1; shift ;;
    --continue) resume=1; shift ;;
    --memory) memory="$2"; shift 2 ;;
    --foreground) foreground=1; shift ;;
    --inside) inside=1; foreground=1; shift ;;
    *) break ;;
  esac
done
[ $# -eq 1 ] || { sed -n '2,12p' "$0" >&2; exit 2; }
name="$1"
run="${CLEANROOM_ROOT:-$HOME/cleanroom}/$name"
ws="$run/workspace"
[ -d "$ws/.git" ] || { echo "no clean room at $run; run setup.sh first" >&2; exit 1; }

for tool in srt bwrap socat rg git cargo quint java node bun go versitygw; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done
cargo kani --version >/dev/null 2>&1 || { echo "missing tool: cargo kani" >&2; exit 1; }

if [ -z "$memory" ]; then
  memory="$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0) * 2 / 5 / 1024 ))M"
  [ "$memory" != "0M" ] || memory=16G
fi
home="$HOME"
mkdir -p "$run/agent/$agent" "$run/tmp" "$run/logs" "$run/cache" "$run/eval" "$home/.quint"
settings="$run/srt-settings.json"
SRT_HOME="$home" SRT_RUN="$run" SRT_AGENT="$agent" SRT_UID="$(id -u)" python3 -I - > "$settings" <<'EOF'
import json, os
home, run, agent = os.environ["SRT_HOME"], os.environ["SRT_RUN"], os.environ["SRT_AGENT"]
toolchains = [".cargo/bin", ".rustup", ".kani", ".quint", ".bun/bin", ".local/bin",
              ".local/node", ".local/jdk", ".local/go", ".local/share/claude",
              ".local/share/codex-cli"]
# Tools on PATH are often symlinks into a toolchain elsewhere in $HOME (for
# example ~/.cargo/bin/cc -> ~/.local/gcc-15/...); allow each target's
# top-level toolchain directory so the tool actually runs.
for link_dir in (".cargo/bin", ".local/bin"):
    try: names = os.listdir(f"{home}/{link_dir}")
    except OSError: continue
    for name in names:
        target = os.path.realpath(f"{home}/{link_dir}/{name}")
        if not target.startswith(home + "/"): continue
        parts = os.path.relpath(target, home).split("/")
        depth = 3 if parts[:2] == [".local", "share"] else 2
        if len(parts) > depth and not any(parts[:depth] == t.split("/")[:depth] for t in toolchains):
            toolchains.append("/".join(parts[:depth]))
domains = {
    "claude": ["api.anthropic.com", "*.anthropic.com", "claude.ai", "*.claude.ai", "*.claude.com"],
    "codex": ["api.openai.com", "*.openai.com", "chatgpt.com", "*.chatgpt.com"],
    "custom": [],
}[agent]
print(json.dumps({
    "filesystem": {
        # /run/user holds this user's D-Bus and keyring sockets.
        "denyRead": ["/home", "/root", "/run/user", f"/tmp/claude-{os.environ['SRT_UID']}"],
        "allowRead": [f"{run}/workspace", f"{run}/agent/{agent}", f"{run}/tmp", f"{run}/cache",
                      f"{run}/eval"]
                     + [f"{home}/{path}" for path in toolchains],
        "allowWrite": [f"{run}/workspace", f"{run}/agent/{agent}", f"{run}/tmp", f"{run}/cache",
                       f"{run}/eval", f"{home}/.quint"],
        "denyWrite": [f"{run}/workspace/vendor"],
    },
    "network": {
        "allowedDomains": domains + [
            # The Go module proxy redirects module downloads to Google Cloud Storage.
            "crates.io", "*.crates.io", "registry.npmjs.org", "proxy.golang.org",
            "storage.googleapis.com",
            "sum.golang.org", "docs.rs", "doc.rust-lang.org", "quint.sh",
            "model-checking.github.io"],
        "deniedDomains": [],
        # srt's Unix-socket seccomp helper needs nested user namespaces, which
        # Ubuntu's AppArmor refuses; host sockets stay hidden via /run/user.
        "allowAllUnixSockets": True,
    },
}, indent=2))
EOF

# A curated environment: nothing from this shell leaks in except what is listed.
envs=(
  # srt sets the sandbox's TMPDIR from CLAUDE_CODE_TMPDIR, else /tmp/claude,
  # which it does not create.
  "HOME=$home" "TMPDIR=$run/tmp" "CLAUDE_CODE_TMPDIR=$run/tmp" "TERM=${TERM:-dumb}" "LANG=${LANG:-C.UTF-8}"
  "PATH=$home/.local/bin:$home/.cargo/bin:$home/.bun/bin:$home/.local/go/bin:/usr/local/bin:/usr/bin:/bin"
  "RUSTUP_HOME=$home/.rustup" "CARGO_HOME=$run/cache/cargo"
  "GOPATH=$run/cache/go" "GOCACHE=$run/cache/go-build" "GOFLAGS=-modcacherw"
  "npm_config_cache=$run/cache/npm" "BUN_INSTALL_CACHE_DIR=$run/cache/bun"
  "XDG_CACHE_HOME=$run/cache/xdg" "XDG_CONFIG_HOME=$run/agent/$agent/config"
  "GIT_AUTHOR_NAME=basinsync clean room" "GIT_AUTHOR_EMAIL=cleanroom@localhost"
  "GIT_COMMITTER_NAME=basinsync clean room" "GIT_COMMITTER_EMAIL=cleanroom@localhost"
  "GIT_CONFIG_GLOBAL=/dev/null" "CLEANROOM_MEMORY_MAX=$memory"
)
extra=()
# Clear the environment and export only the curated variables. Exporting
# (rather than passing `env -i VAR=...` arguments) keeps tokens out of argv,
# which other local users can read through /proc.
in_sandbox() { (
  cd "$ws"
  for variable in $(compgen -e); do unset "$variable" 2>/dev/null || true; done
  export "${envs[@]}" "${extra[@]}"
  exec srt --settings "$settings" "$@"
); }

# Probe the sandbox before trusting it with an agent.
probe='set -u; fail=0
for path in "$HOME/git" "$HOME/.claude" "$HOME/.ssh" "$HOME/.local/share/keyrings" "/tmp/claude-$(id -u)"; do
  if ls "$path" >/dev/null 2>&1 && [ -n "$(ls -A "$path" 2>/dev/null)" ]; then echo "LEAK: $path is readable"; fail=1; fi
done
touch .cleanroom-probe && rm .cleanroom-probe || { echo "workspace is not writable"; fail=1; }
if curl -sS -m 10 -o /dev/null https://github.com 2>/dev/null; then echo "LEAK: github.com is reachable"; fail=1; fi
curl -sS -m 10 -o /dev/null https://index.crates.io/config.json || { echo "crates.io is unreachable"; fail=1; }
exit $fail'
if [ "$inside" -eq 0 ] && ! in_sandbox bash -c "$probe"; then
  echo "sandbox probe failed; refusing to run" >&2; exit 1
fi
[ "$inside" -eq 1 ] || echo "sandbox probe passed"
[ "$check_only" -eq 0 ] || exit 0

# Check credentials before detaching, so a missing token fails here, not in the unit.
CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN//[[:space:]]/}"
case "$agent" in
  claude) [ -n "${CLAUDE_CODE_OAUTH_TOKEN}${ANTHROPIC_API_KEY:-}" ] ||
    { echo "set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY" >&2; exit 1; } ;;
  codex) [ -n "${OPENAI_API_KEY:-}" ] || { echo "set OPENAI_API_KEY" >&2; exit 1; } ;;
esac

# Detach into a memory-capped systemd unit unless asked to stay in the foreground.
unit="cleanroom-$name"
if [ "$foreground" -eq 0 ]; then
  command -v systemd-run >/dev/null ||
    { echo "systemd-run is unavailable; rerun with --foreground (no memory cap)" >&2; exit 1; }
  if systemctl --user is-active --quiet "$unit.service"; then
    echo "$unit is already running; see scripts/cleanroom/status.sh $name" >&2; exit 1
  fi
  systemctl --user reset-failed "$unit.service" 2>/dev/null || true
  systemctl --user stop "$unit.service" 2>/dev/null || true
  # Name-only --setenv copies values from this environment, keeping them out of argv.
  setenvs=(--setenv=CLEANROOM_ROOT="${CLEANROOM_ROOT:-$HOME/cleanroom}")
  for variable in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY; do
    [ -z "${!variable:-}" ] || setenvs+=(--setenv="$variable")
  done
  systemd-run --user --quiet --unit="$unit" --description="basinsync clean room $name" \
    -p MemoryMax="$memory" -p MemorySwapMax=0 -p OOMPolicy=continue \
    -p CPUWeight=50 -p Nice=5 "${setenvs[@]}" \
    "$(realpath "$0")" --inside "${args[@]}"
  cat <<EOM
Started $unit (memory cap $memory).
Do not end your turn yet: run scripts/cleanroom/wait.sh $name, repeat it while
it exits 3 (still running), then report the outcome. status.sh $name shows
progress, memory, recent actions, errors, and blockers at any time.
EOM
  exit 0
fi

# Model checkers can outgrow the unit's cap, and under that pressure the kernel
# may kill the agent instead (the third run lost its agent after three CBMC
# kills). Kill an oversized checker first, at 70% of the cap, and log it.
watchdog() {
  local cap_kb limit_kb cgroup procs pid name rss
  cap_kb=$(( $(numfmt --from=iec "${memory%B}") / 1024 ))
  limit_kb=$(( cap_kb * 7 / 10 ))
  cgroup="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)"
  while sleep 2; do
    procs="$(cat "$cgroup/cgroup.procs" 2>/dev/null)" || continue
    for pid in $procs; do
      name="$(cat "/proc/$pid/comm" 2>/dev/null)" || continue
      case "$name" in cbmc|kani*|java|z3|goto-*) ;; *) continue ;; esac
      rss="$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)"
      if [ "${rss:-0}" -gt "$limit_kb" ]; then
        kill -9 "$pid" 2>/dev/null &&
          printf '%s killed %s (pid %s) at %s kB; limit %s kB\n' "$(date -u +%FT%TZ)" "$name" "$pid" "$rss" "$limit_kb" >> "$run/logs/watchdog.log"
      fi
    done
  done
}
if [ "$inside" -eq 1 ]; then
  watchdog & watchdog_pid=$!
fi

prompt="Read AGENTS.md and carry out the clean-room rebuild it describes. Work until every deliverable is done or blocked, committing as you go."
log="$run/logs/$agent-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
# Builtins only: a stopping unit kills child processes such as date(1).
status() {
  local now; TZ=UTC printf -v now '%(%Y-%m-%dT%H:%M:%SZ)T' -1
  printf '{"state": "%s", "agent": "%s", "transcript": "%s", "pid": %s, "time": "%s"%s}\n' \
    "$1" "$agent" "$log" "$$" "$now" "${2:-}" > "$run/status.json.tmp"
  mv "$run/status.json.tmp" "$run/status.json"
}
if [ "$agent" = custom ]; then status() { :; }; fi  # oracle and probe commands
status running
trap 'code=$?; [ -z "${watchdog_pid:-}" ] || kill "$watchdog_pid" 2>/dev/null; status finished ", \"exit\": $code"' EXIT
trap 'trap - EXIT; status stopped ", \"exit\": 143, \"signal\": \"TERM\""; exit 143' TERM INT
case "$agent" in
  claude)
    # Long tokens pasted from a terminal often pick up wrapped-line whitespace.
    CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN//[[:space:]]/}"
    [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] ||
      { echo "set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY" >&2; exit 1; }
    extra=("CLAUDE_CONFIG_DIR=$run/agent/claude" "CLAUDE_CODE_TMPDIR=$run/tmp")
    [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || extra+=("CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
    [ -z "${ANTHROPIC_API_KEY:-}" ] || extra+=("ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
    flags=(-p "$prompt" --model "${model:-opus}" --dangerously-skip-permissions --output-format stream-json --verbose)
    [ "$resume" -eq 0 ] || flags=(--continue "${flags[@]}")
    in_sandbox claude "${flags[@]}" < /dev/null > "$log" ;;
  codex)
    [ -n "${OPENAI_API_KEY:-}" ] || { echo "set OPENAI_API_KEY" >&2; exit 1; }
    extra=("CODEX_HOME=$run/agent/codex" "OPENAI_API_KEY=$OPENAI_API_KEY")
    in_sandbox codex exec --json --dangerously-bypass-approvals-and-sandbox ${model:+--model "$model"} "$prompt" < /dev/null > "$log" ;;
  custom)
    in_sandbox bash -c "$command" > "$log" ;;
  *) echo "unknown agent: $agent" >&2; exit 2 ;;
esac
echo "agent finished; transcript: $log"
