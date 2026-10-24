[differential-event]: <glossary/differential-event.md>
[logical-frame]: <glossary/logical-frame.md>
[milestone]: <glossary/milestone.md>
[physical-frame]: <glossary/physical-frame.md>
[sha384]: <glossary/sha384.md>
[turso]: <glossary/turso.md>
[wal]: <glossary/wal.md>

# Turso state deltas

An `sts/0/databasin/ingestturso` command carries `{ turso: { [id]: delta } }`,
with id `default.turso`:

```ts
{
  version: string;
  logical: {
    base: Uint8Array | null;
    header: Uint8Array;
    frames: Uint8Array[];
  };
  physical: {
    format: "sqlite-wal/1";
    base: string;
    milestone: string;
    parent: string | null;
    base_sha384: string | null;
    segments: Uint8Array[];
  };
}
```

`version` identifies the *Turso*[^][turso] release and revision; reject
incompatible versions. `logical.header` is the 56-byte native log header;
`logical.frames` contains the *logical frames*[^][logical-frame], including portable changes,
without that header. All byte payloads are binary blobs.

Each `physical.segments` entry is a complete *physical WAL*[^][wal] segment,
including its header, *page frames*[^][physical-frame], and commit boundary. Validate native checksums,
salts, page size, and committed boundaries before installing pages.

`physical.base` and `physical.milestone` are consecutive decimal
*Milestones*[^][milestone]. `parent` is the hexadecimal *SHA-384*[^][sha384] of the
preceding encoded *DifferentialEvent*[^][differential-event], or `null` at the
beginning. The first delta also carries the initialized database in `logical.base`
and its checksum in `base_sha384`; both are `null` thereafter. This binds replay
to a verified initial image and ordered history without hashing whole database
files per transaction.
