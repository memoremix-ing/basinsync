[durable-storage]: <durable-storage.md>
[mvcc]: <mvcc.md>
[turso-manual]: <https://github.com/tursodatabase/turso/blob/main/docs/manual.md>

# Turso

A *SQLite-compatible database engine*[^][turso-manual] written in Rust.
Its *MVCC*[^][mvcc] journal records row versions; checkpointing materializes them into
B-tree pages. *DurableStorage*[^][durable-storage] permits a custom logical-log durability backend.
