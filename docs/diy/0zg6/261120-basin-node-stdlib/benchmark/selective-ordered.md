[selective-ordered]: <selective-ordered.json>

# Selective ordered export

Historical directory measurements before the contents-only descriptor layout;
the B-tree measurements are unchanged by that layout update.

Bun 1.4.5, five alternating trials, memory storage. Medians below; *raw trials*[~][selective-ordered]
assert identical canonical root digests for both paths. Counts are adapter calls,
not newly allocated objects.

| Replacement | Full ms | Selective ms | GETs full → selective | PUT calls full → selective |
|---|---:|---:|---:|---:|
| B-tree, 100,000 rows | 95.1 | 5.4 | 0 → 0 | 101 → 2 |
| Directory, 100 distinct folders × 20 files | 61.1 | 21.8 | 111 → 12 | 112 → 4 |

Both B-tree paths create two objects; both directory paths create four. B-tree
editor materialization is excluded equally and leaves this fixture cached. Cheap
export does not imply lazy editor loading. Insertions/deletions can shift canonical
rank partitions across many siblings; reuse requires matching shape, not just bounds.

Directory measurements include changed-block construction, ancestor hashes and
metadata export from a cold reader. Reuse skips untouched directory bodies and
unchanged file bodies. Ancestor SHA-384 still scans immediate basenames and child
digests; wide-directory hashing is not constant time.
