# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0008 — CommitMarker edges with node promotion](docs/diy/0008-commit-marker-edges-with-node-promotion.md):
authenticated marker edges, bounded depth-first marking, and restartable promotion
of retained graphs from young to old storage outside the request path, with
PromotionSigns certifying completion.
