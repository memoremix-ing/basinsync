# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0003 — Turso Basin VFS](docs/diy/0003-turso-basin-vfs.md):
Turso state, WAL frame capture, durable command batches, and copy-on-write VFS
experiments. The tutorial distinguishes the running server from its prototypes.
