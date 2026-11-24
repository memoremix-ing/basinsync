[bromberg-sl2]: <glossary/bromberg-sl2.md>
[envbuf]: <glossary/envbuf.md>
[lexidecimal]: <glossary/lexidecimal.md>
[node-degree]: <glossary/node-degree.md>
[node-format]: <node-format.md>
[strong-edge]: <glossary/strong-edge.md>
[weak-link]: <glossary/weak-link.md>

# Trie format 0

Use the *shared node format*[~][node-format].

Keys are byte strings; hexadecimal input must encode whole bytes. Sort uniquely
by unsigned bytes. Headers carry the maximal common byte prefix and inclusive
bounds on the remaining key space before consuming that prefix. Header `keys` and
`lengths` describe suffixes relative to the incoming node base, not absolute paths.
An intact subtree retains these fields when its ancestor prefix changes. Groups store
suffixes after consumed bytes. A high-nibble group retains its next byte; a
low-nibble branch consumes that whole byte. Arrays use nibble indices and omit
trailing null slots.

With default packing, up to 255 entries stay in one group. On overflow, keep only
a prefix-ending entry there; partition the rest by high nibble, retaining groups of at most 255,
then by low nibble into recursive trie nodes. If prospective inline values exceed
1280, replace every nested node with a *basin edge*[~][strong-edge]. If value edges
would exceed the configured *degree*[~][node-degree], also expand high-nibble
groups before cutting. Reject any still-oversized node. Collapse by these same
content-derived rules. Trie-header `degree` counts immediate groups/child nodes;
`inlined` counts values before crossing *basin edges*[~][strong-edge].

Consumer aggregation is ordered by full key, with a supplied empty identity.
Relocatable consumer summaries must be independent of ancestor prefixes; structural
counts and content-only checksums qualify, while hashes of absolute keys do not.
Reversed-key bounds, when useful, belong in consumer-defined footer summaries.
Replicate headers and summaries across *basin edges*[~][strong-edge] for pruning.
Volume format 0 uses 4096-byte pages for its file convenience API. Raw page maps accept arbitrary-size blobs and sparse nonnegative
*Lexidecimal*[~][lexidecimal] page numbers, including empty blobs. Sector summaries compose *BrombergSL2*[~][bromberg-sl2]
checksums over stored blobs in page order; empty content uses the identity
matrix. This summary excludes page addresses; node digests identify the complete
structure. Directory digests hash entries
in UTF-8 basename order:

```text
SHA384(concat(u32le(name.length), name,
              kind:u8, u32le(child_digest.length), child_digest))
kind: directory=1, file=0; name: UTF-8 bytes
```

Directories are descriptors with inline-or-edged basename contents tries; file
entries carry strong block edges. Contents-trie inline counts include embedded
child directories and reset at stored edges. Enforce the 1280 budget per physical
node, splitting even small name groups when nested cost requires it.

Blocks carry page tries and leading/lagging *weak spines*[~][weak-link], indexed
by stored height. Hints include incoming key prefixes, links and SHA-384 digests
of complete target *EnvBufs*[~][envbuf]. They bypass intermediate reads where available, with strong-path fallback for
unavailable or stale targets. Full file reads
also check the composed checksum; partial reads check fetched object digests.
A storage adapter supplies reads and optional shortcut resolution using these
revisioned addresses; signed URLs stay out of the stored graph.
