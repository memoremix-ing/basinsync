# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0005 — Shallow heap management](docs/diy/0005-shallow-heap-management.md):
durable reservations for opaque height-zero nodes, with conditional upload and
read actions. Access tokens never enter persistent state. The two-batch pipeline
acknowledges success after durable, ordered Timeline publication.
