#!/usr/bin/env bash
# Start a clean room's server under this repository's environment names, so
# the TypeScript suites (BASINSYNC_SERVER=this script) can drive it.
# CLEANROOM_SERVER_BIN names the binary; CLEANROOM_SERVER_ENV_MAP is a file of
# THEIRS=OURS lines, e.g. BASINSYNC_S3_ENDPOINT=S3_ENDPOINT.
set -euo pipefail
while IFS='=' read -r theirs ours; do
  [ -n "$theirs" ] && [ "${theirs:0:1}" != "#" ] || continue
  [ -z "${!ours+x}" ] || export "$theirs=${!ours}"
done < "${CLEANROOM_SERVER_ENV_MAP:-/dev/null}"
exec "$CLEANROOM_SERVER_BIN" "$@"
