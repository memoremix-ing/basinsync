# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0007 — Deep heap support](docs/diy/0007-deep-heap-support.md):
authenticated child edges, verified stored targets, immutable node descriptors,
and bounded recursive reclamation through the durable Timeline.
