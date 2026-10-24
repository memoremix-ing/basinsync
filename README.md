# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0004 — Basin backup and recovery](docs/diy/0004-basin-backup-recovery.md):
a file-backed copy-on-write VFS, background Flow replication and Basin snapshots,
and recovery from the latest snapshot plus its Timeline suffix. The two-batch
pipeline still acknowledges success after durable, ordered Timeline publication.
