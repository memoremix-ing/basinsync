# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0006 — Async shallow cleanup](docs/diy/0006-async-shallow-cleanup.md):
durable, bounded reclamation queues and background object deletion. UUIDv4
revisions keep delayed deletions scoped to earlier allocations of a reusable node id.
