#!/usr/bin/env bash
# Fetch a clean room's work into this repository as an orphan branch,
# cleanroom/NAME, for review and for running the hidden oracles against it.
#
#   scripts/cleanroom/collect.sh NAME
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 NAME" >&2; exit 2; }
ws="${CLEANROOM_ROOT:-$HOME/cleanroom}/$1/workspace"
[ -d "$ws/.git" ] || { echo "no clean room at $ws" >&2; exit 1; }
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
git -C "$repo" fetch --no-tags "$ws" "+cleanroom/rebuild:cleanroom/$1"
git -C "$repo" log --oneline -5 "cleanroom/$1"
