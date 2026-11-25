#!/usr/bin/env bash
# Create a clean-room workspace that holds only docs/ from a basinsync ref.
#
#   scripts/cleanroom/setup.sh [--ref REF] [--brief full|codec] NAME
#
# full (default): rebuild the server. The codec kit (scripts/cleanroom/kit/codec)
#   is provided read-only in vendor/basinsync-codec, with Turso in vendor/turso.
# codec: rebuild only the codecs, Kani proofs, and oracle CLI, from docs alone;
#   a passing result can refresh the kit with kit-import.sh.
#
# The run lives in ${CLEANROOM_ROOT:-~/cleanroom}/NAME:
#   workspace/  fresh git repository: docs/, AGENTS.md brief, CLAUDE.md pointer,
#               and vendor/turso, the pinned upstream Turso source (read-only,
#               untracked); GitHub is unreachable from the sandbox
#   agent/      per-agent config homes (filled by run.sh)
#   tmp/        TMPDIR inside the sandbox
#   logs/       agent transcripts; never visible inside the sandbox
set -euo pipefail

ref=HEAD brief=full
usage="usage: $0 [--ref REF] [--brief full|codec] NAME"
while [ $# -gt 1 ]; do
  case "$1" in
    --ref) ref="$2"; shift 2 ;;
    --brief) brief="$2"; shift 2 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
[ $# -eq 1 ] || { echo "$usage" >&2; exit 2; }
case "$brief" in full) brief_file=brief.md ;; codec) brief_file=brief-codec.md ;; *) echo "$usage" >&2; exit 2 ;; esac
name="$1"
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "NAME must match [A-Za-z0-9._-]+" >&2; exit 2; }

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
commit="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"
root="${CLEANROOM_ROOT:-$HOME/cleanroom}"
run="$root/$name"
[ ! -e "$run" ] || { echo "$run already exists" >&2; exit 1; }

mkdir -p "$run/workspace" "$run/agent" "$run/tmp" "$run/logs"
git -C "$repo" archive "$commit" docs | tar -x -C "$run/workspace"
# The brief comes from the same ref, so a rebuild can be repeated exactly.
git -C "$repo" show "$commit:scripts/cleanroom/$brief_file" > "$run/workspace/AGENTS.md"
git -C "$repo" show "$commit:scripts/cleanroom/oracle-interface.md" > "$run/workspace/ORACLE-INTERFACE.md"
printf '@AGENTS.md\n' > "$run/workspace/CLAUDE.md"
printf 'target/\nnode_modules/\n.cache/\nvendor/\n' > "$run/workspace/.gitignore"
if [ "$brief" = full ]; then
# The codec kit from the same ref, read-only like Turso.
mkdir -p "$run/workspace/vendor/basinsync-codec"
git -C "$repo" archive "$commit" scripts/cleanroom/kit/codec |
  tar -x -C "$run/workspace/vendor/basinsync-codec" --strip-components=4
# The docs pin Turso to the revision this ref's submodule records.
turso="$(git -C "$repo" ls-tree "$commit" vendor/turso | awk '$2 == "commit" {print $3}')"
[ -n "$turso" ] || { echo "$commit has no vendor/turso submodule" >&2; exit 1; }
mkdir -p "$run/workspace/vendor/turso"
# Leave out Turso's own agent instructions and skills; they are not ours to give.
git -C "$repo/vendor/turso" archive "$turso" | tar -x -C "$run/workspace/vendor/turso" \
  --exclude=CLAUDE.md --exclude=AGENTS.md --exclude=.claude --exclude=.codex --exclude=.agents
fi

cd "$run/workspace"
git init -q -b cleanroom/rebuild
# srt mounts empty placeholders over these to keep the agent from writing them;
# hide them from git status rather than the agent's own .gitignore.
printf '%s\n' /.bash_profile /.bashrc /.gitconfig /.gitmodules /.idea /.mcp.json \
  /.profile /.ripgreprc /.vscode /.zprofile /.zshrc >> .git/info/exclude
git add -A
GIT_AUTHOR_NAME="basinsync clean room" GIT_AUTHOR_EMAIL=cleanroom@localhost \
GIT_COMMITTER_NAME="basinsync clean room" GIT_COMMITTER_EMAIL=cleanroom@localhost \
  git -c commit.gpgsign=false commit -q -m "Clean-room brief and basinsync documentation

Documentation and brief from basinsync $commit."
printf '{"name": "%s", "source": "%s", "brief": "%s", "created": "%s"}\n' \
  "$name" "$commit" "$brief" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$run/run.json"
echo "$run"
