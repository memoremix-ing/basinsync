# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0004 — Basin backup and recovery](docs/diy/0004-basin-backup-recovery.md):
background Flow replication and pinned Basin snapshots. Append-only command
envelopes, indexed marker locations, and signed byte-range GETs keep latest
markers accessible before replication. The two-batch pipeline acknowledges
success after durable, ordered Timeline publication.
