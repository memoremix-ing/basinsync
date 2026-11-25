---
prerequisites:
  - 0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie
---

[content-defined-chunking]: <../../../../../glossary/content-defined-chunking.md>
[crc64nvme]: <../../../../../glossary/crc64nvme.md>
[experiment]: <benchmark/history/experiment.md>
[format]: <format.md>
[sync-block]: <../../../../../glossary/sync-block.md>
[trie.d]: <../../0zg7/261120-byte-trie/trie.d.ts>
[trie]: <../../../../../glossary/trie.md>

# Content-defined byte tries

Give each *SyncBlock*[~][sync-block] two *byte tries*[~][trie]: a content-defined
prefix and a page-defined suffix. Either may be empty. The file is their concatenation;
page indexes are relative to the suffix, so changing the prefix need not renumber pages.
Turso chooses an empty prefix; Markdown can choose an empty suffix.

Use *content-defined chunking*[~][content-defined-chunking] for the prefix, with
one-based ordinal chunk keys. Its reader navigates byte ranges using replicated
`size` summaries. The suffix retains zero-based page keys and declares its page size.
Range reads may cross the boundary. Keep leading/lagging page spines on the suffix.

Combine prefix and suffix *CRC64NVME*[~][crc64nvme] summaries to obtain the whole-file
digest used by directory checksums; partitioning must not affect it. Keep the existing
stored-object integrity and hash-pruned diff machinery. Refine unmatched bytes into
useful patches and verify reconstruction against independent contents.

The *schema declarations*[~][trie.d] and *format notes*[~][format] define the layout.
The *measurements*[~][experiment] motivating content-defined chunks remain available;
they compare the earlier alternatives rather than benchmark this combined block format.
