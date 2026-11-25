[prolly-treelist.d]: <prolly-treelist.d.ts>
[sha384]: <../../../../../glossary/sha384.md>

# Experimental file format, structural schema 0

The *declarations*[~][prolly-treelist.d] distinguish leaf bytes from routing children;
exactly one is non-null. Empty files are empty leaves. Replicate headers and summaries
in edges. Byte sizes exclude framing and physical storage identifiers.

Build the 256-entry Gear table with unsigned 32-bit arithmetic:

```text
x = 0x9e3779b9
for each table entry:
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    table[entry] = x
```

Starting with `hash = 0`, consume each byte using
`hash = ((hash << 1) + table[byte]) mod 2^32`. After `min` bytes, close when
`boundary & (target - 1) == 0`; always close at `max`. `boundary = hash` for
`low`; the default `mixed` policy avalanches it with unsigned 32-bit arithmetic:

```text
boundary = hash
boundary ^= boundary >>> 16; boundary *= 0x7feb352d
boundary ^= boundary >>> 15; boundary *= 0x846ca68b
boundary ^= boundary >>> 16
```

With `runAnchors`, also close
before a changed byte after at least 64 identical bytes, provided `min` is reached.
Reset hash and run state at every boundary. Caller fragment boundaries do not reset
anything. Mark forced/content boundaries `closed`; an unfinished EOF chunk is not.
Revisit its predecessor when editing a boundary dependent on the next byte.
When resynchronizing, a uniform successor supplies that lookahead without fetching
its body; do not wait until its first byte has already entered the next chunk.

Group children in order, closing at `branchMax` or, after at least two children,
when the first four content-hash bytes interpreted little-endian, masked by
`branchTarget - 1`, equal zero. Repeat until one root remains. EOF groups may contain
one child; avoid adding a level when only one descriptor remains.

Use *SHA-384*[~][sha384] with UTF-8 domain strings:

```text
leaf   = SHA384("basinsync/prolly-treelist/0/leaf/" || raw bytes)
branch = SHA384("basinsync/prolly-treelist/0/branch/" ||
                 concat(child.content || decimal(child.size) || ";"))
```

Content IDs exclude keys, policy labels, allocation identifiers and serialization.
Shapes depend on policy; different policies need not yield equal logical roots.
A fetched node must reproduce its advertised content ID as well as pass physical
object integrity checks. These experimental identities do not replace storage digests.

Replicate `uniform`, either the common byte (0–255) or null. Empty leaves use null;
branches retain a byte only when every child has that same value. Validate fetched
leaves against their bytes and branches against their child summaries. Uniform spans
can be split virtually during comparison without loading their descendants.

Diffing trusts supplied root descriptors and authenticated child descriptors, as with
content IDs. Expand unmatched frontiers with at most four concurrent expansions.
Use the same ordered-anchor alignment and 64 KiB refinement windows for both trie
and treelist controls. For unmatched spans totaling at most 256 KiB, try a local
insert/delete edit script capped at distance 256; scan larger equal-length gaps
in bounded windows. Fall back to a coarse replacement when local edit distance
exceeds its budget. These bounds limit working memory, not worst-case
file traversal or global edit-script optimality.

When one side is entirely one byte, collect the other side's equal/unequal runs,
skipping uniform subtrees. Match the available equal-byte budget and emit the
remaining replacements; invert ranges for the reverse direction. Cap temporary
run descriptors at 8,192 and fall back to ordinary comparison beyond that budget.
This avoids a large coarse replacement for scattered edits in an all-zero file.
