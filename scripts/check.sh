#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 docs/skills/basinsync-tutorial-dag/scripts/check_dag.py docs/diy .docs/diy
python3 docs/skills/basinsync-tutorial-dag/scripts/test_check_dag.py
mkdir -p .local/bin
CGO_ENABLED=0 GOBIN="$PWD/.local/bin" go install github.com/versity/versitygw/cmd/versitygw@v1.11.0
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked --examples
cargo build --locked
bun install --frozen-lockfile
bun run check
bun run test
bun run test:integration
