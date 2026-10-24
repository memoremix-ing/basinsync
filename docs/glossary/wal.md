[mvcc]: <mvcc.md>
[sqlite-wal-format]: <https://www.sqlite.org/fileformat2.html#walformat>
[turso]: <turso.md>

# Physical WAL

*Turso*[^][turso]'s physical write-ahead log contains numbered page images and
transaction commit boundaries. *MVCC*[^][mvcc] checkpointing writes pages to this
log before backfilling the main database.

The *frame layout*[^][sqlite-wal-format] includes page numbers, commit boundaries,
salts, and rolling checksums.
