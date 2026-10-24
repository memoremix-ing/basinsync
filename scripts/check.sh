#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .local/bin
GOBIN="$PWD/.local/bin" go install github.com/go-faster/fs/cmd/fs@v0.15.0
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked --examples
cargo build --locked
bun install --frozen-lockfile
bun run check
bun test
bun run test:integration
