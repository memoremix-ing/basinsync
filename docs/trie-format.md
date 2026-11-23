[access-token]: <glossary/access-token.md>
[bromberg-sl2]: <glossary/bromberg-sl2.md>
[envbuf]: <glossary/envbuf.md>
[flexbuffers]: <glossary/flexbuffers.md>
[flow]: <glossary/flow.md>
[hkdf]: <https://www.rfc-editor.org/rfc/rfc5869>
[lexidecimal]: <glossary/lexidecimal.md>
[node]: <glossary/node.md>
[node-degree]: <glossary/node-degree.md>
[node-height]: <glossary/node-height.md>
[object-keys]: <object-keys.md>
[revision]: <glossary/revision.md>
[strong-edge]: <glossary/strong-edge.md>
[weak-link]: <glossary/weak-link.md>

# Trie format 0

Store *basin nodes*[~][node] as numeric-keyed *FlexBuffers maps*[~][flexbuffers]
inside format-`101` *EnvBufs*[~][envbuf]. *Basin edges*[~][strong-edge] are
seven-element `Symbol.match` vectors. Structural schema, consumer migration,
and *node-id*[~][node] version are independent. Readers reject unsupported tags;
consumer migrations rebuild through the old reader and the new consumer.

Keys are byte strings; hexadecimal input must encode whole bytes. Sort uniquely
by unsigned bytes. Headers carry the maximal common byte prefix and inclusive
bounds on the remaining key space before consuming that prefix. Groups store
suffixes after consumed bytes. A high-nibble group retains its next byte; a
low-nibble branch consumes that whole byte. Arrays use nibble indices and omit
trailing null slots.

Up to 63 entries stay in one group. On overflow, keep only a prefix-ending
entry there; partition the rest by high nibble, retaining groups of at most 63,
then by low nibble into recursive trie nodes. If prospective inline values exceed
1280, replace every nested node with a *basin edge*[~][strong-edge]. If value edges
would exceed the configured *degree*[~][node-degree], also expand high-nibble
groups before cutting. Reject any still-oversized node. Collapse by these same
content-derived rules. Trie-header `degree` counts immediate groups/child nodes;
`inlined` counts values before crossing *basin edges*[~][strong-edge].

Consumer aggregation is ordered by full key, with a supplied empty identity.
Replicate headers and summaries across *basin edges*[~][strong-edge] for pruning.
`breadth` sums direct degree and child breadth; like `weight`, it may count shared
nested contributions repeatedly. *Height*[~][node-height] counts only storage
boundaries. Writes supply the distinct outgoing *strong edges*[~][strong-edge]
to storage; *weak links*[~][weak-link] do not retain targets. Both carry the
node allocation's UUIDv4 *revision*[~][revision]. Storage returns that revision
before the parent is encoded; readers derive the shared-heap *object key*[~][object-keys]
from the token, height, version, and revision. No *Flow*[~][flow] revision is needed for
these shared objects. Tenant storage configuration and signing stay outside the graph.

A client secret of at least 32 bytes derives 32-byte entropy using
`HMAC-SHA384(seed, UTF8("basinsync/basin-node/entropy/0") || SHA384(node_bytes))`.
*HKDF-SHA384*[~][hkdf] uses this entropy, a zero salt, and info
`basinsync/basin-node/0/{token,secret,nonce}`, yielding 32/32/12 bytes.
An *access token*[~][access-token] is derived when requesting storage actions.
The codec currently stores plaintext envelopes; encryption needs its own versioned
storage representation.

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

The device trie strongly retains blocks. Directory and up-to-64 leaf shortcuts
provide direct reads, with strong-path fallback on cache misses. Full file reads
also check the composed checksum; partial reads check fetched object digests.
A storage adapter supplies reads and optional shortcut resolution using these
revisioned addresses; signed URLs stay out of the stored graph.
