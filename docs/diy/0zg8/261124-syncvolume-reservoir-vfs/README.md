---
prerequisites:
  - 0zg7/261118-shallow-basin-backup-nodes
  - 0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie
---

[benchmark]: <benchmark/benchmark.md>
[bromberg-sl2]: <../../../glossary/bromberg-sl2.md>
[crc64nvme]: <../../../glossary/crc64nvme.md>
[diy/0zg2/261023-turso-reservoir-vfs]: <../../0zg2/261023-turso-reservoir-vfs/README.md>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie]: <../../0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie/README.md>
[incremental]: <benchmark/incremental.md>
[kernelspace]: <../../../glossary/kernelspace.md>
[node]: <../../../glossary/node.md>
[sha384]: <../../../glossary/sha384.md>
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

Keep one page per *Lexidecimal trie key*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie],
using ordinary 1,280-value packing by default. Optional tighter budgets compare
one- and sixteen-page objects; they change object granularity, not page size.
On backup, use the VFS history to locate changed pages, path-copy their tries and
directory entries, and retain untouched subtries through *strong edges*[~][strong-edge].
Reuse their summaries without fetching their bodies. Rebuild a file when its
relationship to the prior checkpoint cannot be established; preserve the root on
a no-op. Truncation can drop fully covered subtries without fetching them.
Retain the publication's packing policy with its root; changing that policy
requires full export.
Reuse allocation revisions and a stable seed so unchanged *basin nodes*[~][node]
retain their addresses. Publish the returned root only after every object write
succeeds; a failed backup leaves the prior root usable. The coordinator still
chooses the consistent database prefix represented by those pins.

Compare the existing disk VFS/full-file backups with both loading modes using
real SQL, cold reads, warm reads/writes, changed-object bytes and recovery to
identical database images. Compare full and incremental export independently of
*BrombergSL2*[~][bromberg-sl2] versus *CRC64NVME*[~][crc64nvme]. See the
*baseline measurements*[~][benchmark] and *incremental comparison*[~][incremental].

The CRC experiment uses consumer migration `1` on the volume, block and page-trie
nodes; structural schema `0` is unchanged. Its page summary contains `crc64nvme`
(eight big-endian bytes) and `length` (a bigint byte count). Page values remain
one-blob vectors; file digest bytes follow the block's migration. Keep
*SHA-384*[~][sha384] for stored-object integrity.
Migration `1` is currently a native Rust experiment; migration `0` remains the
cross-language interoperability control.

This experiment exposes the VFS and backup/recovery APIs. The server's shallow
*KernelSpace*[~][kernelspace] reservation, promotion and `commitkernel` protocol
remain a later integration step. A changed object's inline pages still belong to
the replacement object; large inline groups therefore trade fewer GETs for larger
rewrites. Consumer summaries currently exist on logical trie nodes as well as at
stored boundaries; block/volume wrapper summaries are currently null. Incremental
export may read previously unloaded objects when
editing or canonically repacking their contents.
