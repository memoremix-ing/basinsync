# basinsync

A Rust server growing toward immutable data DAGs backed by S3-compatible object
storage. Start with [0001 — Shallow epilogue commits](docs/diy/0001-shallow-epilogue-commits.md):
a first-writer-wins Epilogue, a server, and TypeScript stress clients.

[Run and verify](docs/development.md) · [Protocol and invariant](docs/epilogue-protocol.md)

The current milestone is [0005 — EnvBuf log formatting](docs/diy/0005-envbuf-log-formatting.md):
append-only command envelopes, indexed marker locations, and signed byte-range
GETs for latest markers awaiting Flow replication. The two-batch pipeline still
acknowledges success after durable, ordered Timeline publication.
