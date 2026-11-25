[prolly-file.d]: <prolly-file.d.ts>
[sha384]: <../../../../../glossary/sha384.md>

# Experimental file format, structural schema 0

The *declarations*[~][prolly-file.d] distinguish leaf bytes from routing children;
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
`hash & (target - 1) == 0`; always close at `max`. With `runAnchors`, also close
before a changed byte after at least 64 identical bytes, provided `min` is reached.
Reset hash and run state at every boundary. Caller fragment boundaries do not reset
anything. Mark forced/content boundaries `closed`; an unfinished EOF chunk is not.
Revisit its predecessor when editing a boundary dependent on the next byte.

Group children in order, closing at `branchMax` or, after at least two children,
when the first four content-hash bytes interpreted little-endian, masked by
`branchTarget - 1`, equal zero. Repeat until one root remains. EOF groups may contain
one child; avoid adding a level when only one descriptor remains.

Use *SHA-384*[~][sha384] with UTF-8 domain strings:

```text
leaf   = SHA384("basinsync/prolly-file/0/leaf/" || raw bytes)
branch = SHA384("basinsync/prolly-file/0/branch/" ||
                 concat(child.content || decimal(child.size) || ";"))
```

Content IDs exclude keys, policy labels, allocation identifiers and serialization.
Shapes depend on policy; different policies need not yield equal logical roots.
A fetched node must reproduce its advertised content ID as well as pass physical
object integrity checks. These experimental identities do not replace storage digests.
