#!/usr/bin/env bash
# Archive finished clean rooms as branches of a separate repository: each
# branch is the rebuild's own history plus one commit adding cleanroom-run/
# (run record, agent output, oracle results, full transcript). Credentials and
# account files under agent/ are never copied; refuse to push on a token hit.
#
#   scripts/cleanroom/archive.sh REMOTE NAME...
#   e.g. scripts/cleanroom/archive.sh git@github.com:memoremix-ing/basinsync-cleanrooms.git 261124-claude-r6
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: $0 REMOTE NAME..." >&2; exit 2; }
remote="$1"; shift
root="${CLEANROOM_ROOT:-$HOME/cleanroom}"
stage="$root/.archive"
[ -d "$stage/.git" ] || git init -q -b main "$stage"
git -C "$stage" remote get-url origin >/dev/null 2>&1 || git -C "$stage" remote add origin "$remote"
export GIT_AUTHOR_NAME="basinsync clean room" GIT_AUTHOR_EMAIL="cleanroom@localhost"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
secrets='sk-ant-[A-Za-z0-9_-]{10}|gh[po]_[A-Za-z0-9]{20}|"oauthAccount"|"emailAddress"'
for run in "$@"; do
  r="$root/$run"
  wt="$stage.wt-$run"
  rm -rf "$wt"
  git -C "$stage" branch -D "$run" >/dev/null 2>&1 || true
  if [ -d "$r/workspace/.git" ] && git -C "$r/workspace" rev-parse -q --verify cleanroom/rebuild >/dev/null; then
    git -C "$stage" fetch -q --no-tags "$r/workspace" "+cleanroom/rebuild:$run"
    git -C "$stage" worktree add -q "$wt" "$run"
  else
    git -C "$stage" worktree add -q --orphan -b "$run" "$wt"
  fi
  dest="$wt/cleanroom-run"
  mkdir -p "$dest"
  for f in run.json outcome.txt status.json; do [ -f "$r/$f" ] && cp "$r/$f" "$dest/"; done
  for d in logs eval; do [ -d "$r/$d" ] && cp -r "$r/$d" "$dest/"; done
  if [ -d "$r/agent/claude/projects" ]; then
    mkdir -p "$dest/transcript"
    cp -r "$r/agent/claude/projects/." "$dest/transcript/"
  fi
  if grep -rqE "$secrets" "$dest" || { [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && grep -rqF "$CLAUDE_CODE_OAUTH_TOKEN" "$dest"; }; then
    echo "$run: possible credential in cleanroom-run/; not archived" >&2
    git -C "$stage" worktree remove --force "$wt"; git -C "$stage" branch -D "$run" >/dev/null
    exit 1
  fi
  git -C "$wt" add -f cleanroom-run
  git -C "$wt" commit -q -m "Archive the $run run record, logs, oracle results and transcript"
  git -C "$stage" worktree remove --force "$wt"
  git -C "$stage" push -q --force origin "$run"
  echo "$run: archived to $remote"
done
