#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 docs/skills/basinsync-tutorial-dag/scripts/check_dag.py
python3 docs/skills/basinsync-tutorial-dag/scripts/test_check_dag.py
mkdir -p .local/bin
CGO_ENABLED=0 GOBIN="$PWD/.local/bin" go install github.com/versity/versitygw/cmd/versitygw@v1.11.0
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
cargo build --locked --workspace --examples
cargo build --locked
bun install --frozen-lockfile
bun run check
bun run check:structures
(cd go/structures && go vet ./... && go test ./... && go build -o ../../.local/structures-go ./cmd/fixture)
bun run test:structures:interop
bun run test
bun run test:integration
