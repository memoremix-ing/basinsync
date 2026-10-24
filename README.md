# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0003 — Turso Basin state](docs/diy/0003-turso-basin-state.md):
16 KiB MVCC database pages and logical/physical frame capture in the Timeline.
