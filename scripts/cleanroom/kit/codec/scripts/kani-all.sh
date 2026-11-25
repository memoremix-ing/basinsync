#!/usr/bin/env bash
# Run every Kani harness in basinsync-codec one at a time, each under a
# timeout and a virtual-memory cap, writing one result line per harness.
#
# Usage: scripts/kani-all.sh [HARNESS...]
#   KANI_TIMEOUT   seconds per harness   (default 900)
#   KANI_MEM_KB    ulimit -v in KiB      (default 16000000)
#   KANI_RESULTS   results file          (default target/kani/results.txt)
#
# Result line: <harness> <PASS|FAIL|TIMEOUT|OOM|ERROR> <seconds>s <peak_rss_kb>KB
set -u
cd "$(dirname "$0")/.."

TIMEOUT="${KANI_TIMEOUT:-900}"
MEM_KB="${KANI_MEM_KB:-16000000}"
OUT_DIR="target/kani"
RESULTS="${KANI_RESULTS:-$OUT_DIR/results.txt}"
mkdir -p "$OUT_DIR/logs"

if [ "$#" -gt 0 ]; then
  harnesses=("$@")
else
  mapfile -t harnesses < <(grep -A3 '#\[kani::proof\]' crates/codec/src/kani_proofs.rs \
    | sed -n 's/^fn \([a-z0-9_]*\)().*/\1/p')
fi

: > "$RESULTS"
for h in "${harnesses[@]}"; do
  log="$OUT_DIR/logs/$h.log"
  timefile="$OUT_DIR/logs/$h.time"
  start=$(date +%s.%N)
  (
    ulimit -v "$MEM_KB"
    /usr/bin/time -f '%M' -o "$timefile" \
      timeout "$TIMEOUT" cargo kani -p basinsync-codec --harness "kani_proofs::$h" --exact
  ) > "$log" 2>&1
  code=$?
  end=$(date +%s.%N)
  secs=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }')
  peak=$(grep -E '^[0-9]+$' "$timefile" 2>/dev/null | tail -1)
  if grep -q 'VERIFICATION:- SUCCESSFUL' "$log" && [ "$code" -eq 0 ]; then
    status=PASS
  elif [ "$code" -eq 124 ]; then
    status=TIMEOUT
  elif [ "$code" -eq 137 ] || grep -qiE 'out of memory|std::bad_alloc|memory allocation failed|CBMC failed with status 6|Killed' "$log"; then
    # CBMC prints "VERIFICATION:- FAILED" after running out of memory too,
    # so memory exhaustion is checked first.
    status=OOM
  elif grep -q 'VERIFICATION:- FAILED' "$log"; then
    status=FAIL
  else
    status=ERROR
  fi
  line="$h $status ${secs}s ${peak:-?}KB"
  echo "$line" | tee -a "$RESULTS"
done
