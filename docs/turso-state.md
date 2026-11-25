[differential-event]: <glossary/differential-event.md>
[logical-frame]: <glossary/logical-frame.md>
[message-schemas]: <message-schemas.md>
[milestone]: <glossary/milestone.md>
[physical-frame]: <glossary/physical-frame.md>
[sha384]: <glossary/sha384.md>
[turso]: <glossary/turso.md>
[turso-source]: <https://github.com/tursodatabase/turso/tree/032f5bb2c7e74107f7ef9b66d576312379000a88>
[wal]: <glossary/wal.md>

# Materialized state deltas

Materialize state in *Turso*[~][turso] at upstream *revision 032f5bb*[~][turso-source]
(crate `turso_core`, release 0.9.0-pre.1), with default features off and `fs`
and `conn_raw_api` enabled. Open each database with `PRAGMA page_size = 16384`
and `PRAGMA journal_mode = mvcc`, and enable portable logical changes on its
connection (`connection.set_portable_logical_changes_enabled(true)`). Disable automatic checkpoints; checkpoint explicitly after each
transaction, capturing its *physical WAL*[~][wal] writes before the checkpoint
truncates them.

An `sts/0/databasin/ingestturso` command carries `{ turso: { [id]: delta } }`,
keyed by database id, including `default.turso` and `kernel.turso`. Every delta must:

- name its build in `version`, `0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88`,
  and readers reject versions they cannot apply;
- apply a delta to the previous state to reproduce the new rows exactly;
- bind each delta to its base and resulting *Milestones*[~][milestone] and to
  the hexadecimal *SHA-384*[~][sha384] of the preceding encoded
  *DifferentialEvent*[~][differential-event] (`null` at the beginning), and
  bind the first delta to a verified initial image;
- apply all of a group's deltas, or none, as described below.

Deltas carry these bindings in `physical`:

```cddl
turso-delta = {
  version: tstr,
  logical: { base: bstr / null, header: bstr .size 56, frames: [bstr] },
  physical: {
    format: "sqlite-wal/1", base: decimal, milestone: decimal,
    parent: hex384 / null, base_sha384: hex384 / null, segments: [* bstr],
  },
}
```

Shared definitions such as `command` and `decimal` are in the *message schemas*[~][message-schemas].

`logical.header` is the 56-byte native log header;
`logical.frames` holds one entry: the transaction's complete *logical frame*[~][logical-frame],
including portable changes, as the log stores it after that header. A delta
covers one database's single transaction for one *Timeline event*[~][differential-event]:
batched requests share that transaction, and each database's delta joins the
same command, so the group applies together. All byte payloads are binary blobs.

Each `physical.segments` entry is a complete *physical WAL*[~][wal] segment,
including its header, *page frames*[~][physical-frame], and commit boundary. Validate native checksums,
salts, page size, and committed boundaries before installing pages.

`physical.base` and `physical.milestone` are consecutive decimal
*Milestones*[~][milestone]. `parent` is the hexadecimal *SHA-384*[~][sha384] of the
preceding encoded *DifferentialEvent*[~][differential-event], or `null` at the
beginning. The first delta also carries the initialized database in `logical.base`
and its checksum in `base_sha384`; both are `null` thereafter. This binds replay
to a verified initial image and ordered history without hashing whole database
files per transaction.

All participants in one group share the same base, resulting *Milestone*[~][milestone],
and predecessor digest. Validate every candidate before advancing the visible
prefix. Local rollback restores the whole group, including writers' engine state
and sidecars; the *Timeline event*[~][differential-event] remains the durable boundary.
