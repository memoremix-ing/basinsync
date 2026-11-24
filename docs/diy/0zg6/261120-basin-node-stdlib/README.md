---
prerequisites:
  - 0zg5/261112-deep-heap-support
---

[AGENTS]: <AGENTS.md>
[client-browser]: <benchmark/client-browser.md>
[continuations]: <benchmark/continuations.md>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie]: <0zg7/261120-byte-trie/README.md>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261123-b-tree]: <0zg7/261123-b-tree/README.md>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261123-bitmapped-vector-trie]: <0zg7/261123-bitmapped-vector-trie/README.md>
[envbuf]: <../../../glossary/envbuf.md>
[flexbuffers]: <../../../glossary/flexbuffers.md>
[node]: <../../../glossary/node.md>
[node-degree]: <../../../glossary/node-degree.md>
[node-format]: <../../../node-format.md>
[revision]: <../../../glossary/revision.md>
[selective-ordered]: <benchmark/selective-ordered.md>
[stdlib.d]: <stdlib.d.ts>
[strong-edge]: <../../../glossary/strong-edge.md>
[wasm-cpu]: <benchmark/wasm-cpu.md>

# Basin node standard library

Build versioned data structures for storage and incremental loading from basinsync.
Distinguish logical structure nodes from stored *basin nodes*[~][node]. Use
numeric-keyed *FlexBuffers maps*[~][flexbuffers] in *EnvBufs*[~][envbuf];
*basin edges*[~][strong-edge] are `Symbol.match` vectors, with allocation
*revisions*[~][revision] for direct shared-storage addressing.

Replicate bounds and consumer summaries across *basin edges*[~][strong-edge] so
readers can prune without fetching. Content hashing is consumer-defined; stored-node integrity checks remain independent. Structural
schema, consumer migration and node-id version remain independent.
`breadth` and `weight` are approximate and may count shared descendants repeatedly.
The default physical *degree limit*[~][node-degree] is 320.

*Shared schema declarations*[~][stdlib.d].

*Byte trie and volume*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie].

*Bitmapped vector trie*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261123-bitmapped-vector-trie].

*B-tree*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261123-b-tree].

The *format reference*[~][node-format] records shared capability derivation and storage conventions.

These codecs serialize plaintext; encryption needs a separate storage representation.

## Implementation considerations

Follow the *implementation and benchmark guidance*[~][AGENTS] when changing this family.

- Measure logical construction/traversal separately from packing, serialization,
  integrity hashing and storage. Compare matching capabilities, not just method names.
- Bisect costs with coarse feature controls, then isolate changes and their
  interactions. Use repeated fresh-process trials and sufficiently long read loops.
- Exploit sorted input: derive bounds from endpoints and partition once instead of
  repeatedly filtering. Prefer offsets/ranges to temporary suffix allocations,
  while retaining ownership at public input boundaries.
- Cache immutable parsed lookup metadata; preserve validation of mutable or
  untrusted descriptors. Let synchronous work stay synchronous, suspending when
  loading actually requires it.
- Separate path-copied logical edits from canonical export; measure both. Preserve
  consumer callback semantics when caching or regrouping summaries.
- Inspect actual serialized widths and bytes: lengths, values and relative offsets
  can each widen representations. Keep optional expensive summaries consumer-defined.
- For format-preserving optimizations, compare serialized bytes and cross-language
  reads, including uncached loads, snapshots, prefixes and packing boundaries.

## Progress and remaining work

TypeScript selectively exports compatible trie, B-tree and directory subtrees;
consumer summaries explicitly opt into composable reuse. Directory ancestor
hashes still scan immediate entries; canonical B-tree rank shifts can repack
siblings. *Export measurements*[~][selective-ordered] count requests separately
from new objects. Native readers interoperate with these snapshots. Directory
contents tries now directly retain file blocks; blocks have page-trie boundary
spines.

Trie and vector editors offer explicit owner-tagged scopes. *Browser CPU
measurements*[~][client-browser] cover logical structures; *Rust/Wasm measurements*[~][wasm-cpu]
cover stored readers. *Matching-miss measurements*[~][continuations] support
retained continuations for now. The *B-tree tutorial*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261123-b-tree]
compares an experimental B+tree with independent branch/leaf budgets.

Rust/Go logical-editor parity, native B+ readers and byte-aware physical packing
remain candidates. Owner-tagged scopes and prefix editors remain TypeScript-only.
These are deferred experiments, not additional format requirements.
