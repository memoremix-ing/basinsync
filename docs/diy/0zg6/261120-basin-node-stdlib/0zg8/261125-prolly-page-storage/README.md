---
prerequisites:
  - 0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie
---

[crc64nvme]: <../../../../../glossary/crc64nvme.md>
[experiment]: <benchmark/experiment.md>
[flexbuffers]: <../../../../../glossary/flexbuffers.md>
[format]: <format.md>
[node]: <../../../../../glossary/node.md>
[page-index]: <benchmark/page-index.md>
[prolly-file.d]: <prolly-file.d.ts>
[prolly-tree]: <../../../../../glossary/prolly-tree.md>
[prolly.d]: <prolly.d.ts>
[sha384]: <../../../../../glossary/sha384.md>
[strong-edge]: <../../../../../glossary/strong-edge.md>

# Prolly file diffs

Experiment with a *prolly tree*[~][prolly-tree] for SyncBlock page storage whose
purpose is efficiently producing byte diffs between files, including insertions
and deletions. Hash ordered contents, excluding keys and storage addresses.
Replicate aggregated byte `size` across *strong edges*[~][strong-edge] so comparisons
and reads can skip unrelated subtrees without fetching them.

Chunk the byte sequence independently of caller page boundaries. Pin a deterministic
policy: Gear32 with 16/64/256 KiB minimum/target/maximum chunks, optionally closing
after a long repeated-byte run when its value changes. Group children by their
content hashes, with target 32/max 128 children. Store blob leaves and routing
*basin nodes*[~][node] as enveloped *FlexBuffers*[~][flexbuffers]; a lone leaf is its
own root. The *file schema*[~][prolly-file.d] records the experimental policy; the *format notes*[~][format] pin its boundary and hash rules.

Use domain-separated *SHA-384*[~][sha384] content identities: raw bytes at leaves,
ordered child content identities and sizes at branches. These differ from stored
object digests and from the composable *CRC64NVME*[~][crc64nvme] byte checksum.
Identical contents under the same policy have identical logical roots regardless
of page partitions or allocation; incompatible policies can require reading bytes.

Compare matching identities without fetching them. Expand unmatched branches and
align ordered content anchors so unchanged subtrees remain useful after shifts.
Return ordered `{ before: { start, length }, after: { start, length } }` replacements.
Refine unmatched spans with bounded-memory byte windows; reconstruction must match
the target even when repeated content yields coarse anchors. This is not a promise
of a globally minimal edit script. Rechunk updates until boundaries resynchronize,
reuse untouched objects, and compare incremental roots with canonical full builds.

The *diff measurements*[~][experiment] include patch sizes and retrieval costs,
not just comparison time. An earlier *page-keyed control*[~][page-index] and its
*schema*[~][prolly.d] isolate page-index tradeoffs. These TypeScript experiments
leave the default SyncVolume/Turso VFS format unchanged.
