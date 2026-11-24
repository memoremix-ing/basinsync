---
prerequisites:
  - 0zg7/261118-shallow-basin-backup-nodes
  - 0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie
---

[benchmark]: <benchmark/benchmark.md>
[diy/0zg2/261023-turso-reservoir-vfs]: <../../0zg2/261023-turso-reservoir-vfs/README.md>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie]: <../../0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie/README.md>
[kernelspace]: <../../../glossary/kernelspace.md>
[node]: <../../../glossary/node.md>
[strong-edge]: <../../../glossary/strong-edge.md>
[turso]: <../../../glossary/turso.md>
[volume]: <../../../glossary/volume.md>

# SyncVolume Reservoir VFS

Experiment with backing `default.turso` and `kernel.turso` by one
*SyncVolume*[~][volume]. Map each zero-based, 16 KiB *Turso page*[~][turso] to a
raw page in its file's *SyncBlock*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie];
the 4 KiB convenience file API does not apply.
Retain the *COW VFS's*[~][diy/0zg2/261023-turso-reservoir-vfs] stable generations
and use immutable page sources beneath its writable disk overlay.

Make mounts lazy about directory lookup. Choose `lazy` to fetch and verify pages
on demand, or `eager` to populate an on-disk cache for the requested file before
opening it. Eager file reads, writes and checkpoints then require no network;
unrequested files and edged folders remain unloaded. Keep the cache in the
configured database directory.

The *page trie*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie] needs
an explicit packing budget: one inline page permits page-level object fetching;
larger groups trade over-fetching for fewer requests. Keep ordinary trie packing
unchanged. On backup, pack the supplied pinned files, path-copy their directory
entries, and retain untouched directories through *strong edges*[~][strong-edge].
Reuse allocation revisions and a stable seed so unchanged *basin nodes*[~][node]
retain their addresses. Publish the returned root only after every object write
succeeds; a failed backup leaves the prior root usable. The coordinator still
chooses the consistent database prefix represented by those pins.

Compare the existing disk VFS/full-file backups with both loading modes using
real SQL, cold reads, warm reads/writes, changed-object bytes and recovery to
identical database images. See the *measurements*[~][benchmark].

This experiment exposes the VFS and backup/recovery APIs. The server's shallow
*KernelSpace*[~][kernelspace] reservation, promotion and `commitkernel` protocol
remain a later integration step. Native export currently scans and repacks the
selected file; structural sharing saves stored/transferred objects, not that CPU
work. Backups may therefore read pages that lazy SQL has not yet requested.
