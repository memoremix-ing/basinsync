#!/usr/bin/env bash
# Refresh the codec kit from a finished codec-only clean room
# (setup.sh --brief codec) whose vectors oracle passed every case.
#
#   scripts/cleanroom/kit-import.sh NAME
#
# Review the diff (git diff scripts/cleanroom/kit) and KANI.md before committing.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 NAME" >&2; exit 2; }
run="${CLEANROOM_ROOT:-$HOME/cleanroom}/$1"
ws="$run/workspace"
kit="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/scripts/cleanroom/kit/codec"
grep -q '"brief": "codec"' "$run/run.json" || { echo "$1 is not a codec-only clean room" >&2; exit 1; }
report="$run/eval/vectors/report.txt"
[ -s "$report" ] || { echo "run scripts/cleanroom/oracle.sh vectors first" >&2; exit 1; }
if awk '$4 != 0 || $6 != 0 {bad=1} END {exit !bad}' <(grep -E '^[a-z0-9]+ +[0-9]+ pass' "$report"); then
  echo "vectors oracle has failures or unsupported cases:" >&2; cat "$report" >&2; exit 1
fi
for path in Cargo.toml Cargo.lock crates/codec crates/oracle scripts/kani-all.sh; do
  [ -e "$ws/$path" ] || { echo "missing $path in $ws" >&2; exit 1; }
done
rm -rf "$kit"; mkdir -p "$kit/crates" "$kit/scripts"
cp "$ws/Cargo.toml" "$ws/Cargo.lock" "$kit/"
cp -r "$ws/crates/codec" "$ws/crates/oracle" "$kit/crates/"
cp "$ws/scripts/kani-all.sh" "$kit/scripts/"
rm -rf "$kit/crates/codec/target" "$kit/crates/oracle/target"
cat > "$kit/KIT.md" <<NOTE
# Codec kit

Imported from codec-only clean room \`$1\` (workspace commit
\`$(git -C "$ws" rev-parse HEAD)\`, docs from basinsync
\`$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['source'])" "$run/run.json")\`).
Its vectors oracle passed every case; see \`crates/codec/KANI.md\` for the proofs.
NOTE
echo "kit refreshed from $1; review: git diff -- $kit"
