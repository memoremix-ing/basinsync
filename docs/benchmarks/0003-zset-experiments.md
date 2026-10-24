[0003-zset-samples]: <data/0003-zset-samples.gz>
[0003-zset-summary]: <data/0003-zset-summary.json>
[basin]: <../glossary/basin.md>
[change-data-capture]: <../glossary/change-data-capture.md>
[differential-dataflow]: <https://docs.rs/differential-dataflow/latest/differential_dataflow/input/struct.InputSession.html>
[feldera-grammar]: <https://docs.feldera.com/sql/grammar/#materialized-tables>
[feldera-json]: <https://docs.feldera.com/formats/json/>
[flexbuffers]: <../glossary/flexbuffers.md>
[flow]: <../glossary/flow.md>
[logical-frame]: <../glossary/logical-frame.md>
[milestone]: <../glossary/milestone.md>
[physical-frame]: <../glossary/physical-frame.md>
[sqlite-session]: <https://www.sqlite.org/sessionintro.html>
[turso]: <../glossary/turso.md>
[turso-compatibility]: <https://github.com/tursodatabase/turso/blob/032f5bb2c7e74107f7ef9b66d576312379000a88/COMPAT.md#callback-functions>
[turso-manual]: <https://github.com/tursodatabase/turso/blob/main/docs/manual.md>
[turso-triggers]: <https://github.com/tursodatabase/turso/blob/032f5bb2c7e74107f7ef9b66d576312379000a88/docs/sql-reference/statements/create-trigger.mdx>
[viewpoint]: <../glossary/viewpoint.md>
[wal]: <../glossary/wal.md>
[z-set]: <../glossary/z-set.md>

# 0003 weighted-row experiments — 2026-10-24

An update in a *Z-set*[^][z-set] retracts the old full row and inserts the new
one. *Differential Dataflow*[^][differential-dataflow] accepts weighted changes;
*Feldera*[^][feldera-json] also accepts keyed upserts, retaining prior values
itself. Old rows must be available somewhere, though they need not travel in
every upstream format.

These are benchmark prototypes; the server's event format is unchanged.
The target is application-independent capture; cursor reuse is only a
schema-specific comparison and does not meet that requirement.
Compare the existing persistent *WAL*[^][wal] path with:

- **Cursor reuse:** derive prior rows from validated *Viewpoints*[^][viewpoint]
  and the *Basin*[^][basin] cursor. Specific to today's two-table schema.
- **Indexed reads:** read each affected *Flow*[^][flow] before writing it.
- **Hook plus row cache:** observe `serialize_row_version`, retaining prior
  rows by table/rowid. Send native records or decoded *FlexBuffers*[^][flexbuffers]
  values. Requires an initial scan and memory proportional to retained rows.
- *Full CDC*[^][change-data-capture]: use
  *Turso's before/after capture*[^][turso-manual], read its table, and retain its
  records for these measurements.

The hook alone is insufficient: some upserts of checkpointed rows expose only
the replacement. Explicit updates and deletes can expose old records, but a
missing retraction cannot safely be interpreted as a new insertion.
*CDC*[^][change-data-capture]'s `AUTOINCREMENT` allocator also emits separate
internal transactions; its prototype captures and verifies multiple
*logical frames*[^][logical-frame],
including internal-only frames. The server currently expects one.

## Measurements

Three rotated rounds, 64/8,192 seeded *Flows*[^][flow], batches of 1/32,
4 KiB marker blobs, 16 KiB pages. Each CPU run measures 512 batches after
64 warmups. S3 runs use 256 requests after 64 warmups against local
`go-faster/fs v0.15.0`. Optimized Rust 1.92.0, Apple M2/24 GiB; engine
`0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88`.

| Procedure; 8,192 *Flows*[^][flow] | CPU p50 ms, 1 request | CPU p50 ms, 32 requests | S3 req/s, 32 requests | Event KiB, 32 requests |
| --- | ---: | ---: | ---: | ---: |
| Existing *WAL*[^][wal] path | 0.208 | 1.376 | 1,411 | 201.2 |
| Cursor reuse | 0.209 | 1.455 | 1,395 | 203.7 |
| Indexed reads | 0.219 | 1.719 | 1,372 | 203.7 |
| Hook + cache, records | 0.209 | 1.367 | 1,366 | 203.4 |
| Hook + cache, values | 0.210 | 1.379 | 1,456 | 203.7 |
| Full *CDC*[^][change-data-capture] | 0.392 | 2.228 | 1,317 | 258.0 |

Cursor reuse adds about 6% CPU and 1.3% event bytes for batches of 32;
S3 throughput is within about 1% of baseline. Smaller differences between
cache/encoding variants are not convincing on this shared host. Single-request
S3 rates stay around 41–43 requests/s across variants.

The 8,193-row cache retains 122,884 bytes of record payload, plus map, vector,
and allocator overhead; its initial scan takes about 2 ms. With 18,432 requests,
retained *CDC*[^][change-data-capture] records grow its database from 512 KiB to
1,600 KiB; other variants remain at 432 KiB. *CDC*[^][change-data-capture]
cleanup would add work beyond these measurements.

The hook-plus-cache variants are small primary-relation mirrors: look up the
old record, emit its retraction, install the new record, and emit its insertion.
The cache is an in-memory `BTreeMap<(table_id, rowid), full_record>`, initialized
by scanning the database. It has no separate database file or SQL engine; its
memory grows with retained row data. This supplies old values even when the
hook reports only an upsert. The combination passed the tested reconstructions;
the bare hook's missing retractions do not rule it out.
*Feldera's keyed tables*[^][feldera-grammar] likewise retain their contents to
support upserts. These benchmarks measure our row-retention/conversion step,
not a Feldera/DBSP runtime, reactive joins or aggregates, or its state-store
checkpoint/recovery costs. The earlier logical-replay shadow database served
verification, not reactive queries.

Timing includes validation, SQL, capture, checkpoint, feed construction,
serialization, event hashing, and conditional S3 PUT where applicable.
Initial scans, reconstruction checks, S3 readback, and HTTP admission/collection
are outside timing. Rates describe measured commit service time.

At every prefix, ingest *physical frames*[^][physical-frame]; compare the final
file with the writer. Fold captured rows into the initial relation and compare
with SQL. Tests additionally cover duplicates, NULL/text/real/blob values,
overflow records, repeated changes, primary-key changes, savepoints, rollback,
no-op updates, and randomized histories. *CDC*[^][change-data-capture] replay
also reproduces physical files from its captured *logical frames*[^][logical-frame].

## Proposed integration

An application-independent row-change feed could add a sibling to `logical`
and `physical` on `ingestturso`'s database delta:

```ts
zsets: {
  format: "row-zset/1",
  tables: {
    flows: {
      columns: ["flow", "viewpoint"],
      rows: [
        { row: ["f", "7"], weight: -1 },
        { row: ["f", "8"], weight:  1 }
      ]
    }
  }
}
```

Rows use SQL column values: the example's counters remain decimal text.
Include captured application tables; combine repeated changes within a transaction
into its net row changes. Use the enclosing *Milestone*[^][milestone] as the
atomic batch boundary. Consumers start from matching initial state and process
each durable batch once; publish no speculative changes before S3 succeeds.

The pinned *Turso*[^][turso] engine exposes no supported preupdate/session API;
its *compatibility matrix*[^][turso-compatibility] marks preupdate hooks
unsupported. *SQLite's session extension*[^][sqlite-session] depends on its
preupdate machinery. A transaction-aware before/after engine hook would be
new work, not an existing API awaiting a benchmark. The existing complete
before/after path is *CDC*[^][change-data-capture], measured above.
*SQL triggers*[^][turso-triggers] also expose `OLD`/`NEW`; generated triggers
writing a transactional change table are unmeasured and still add SQL writes.

The retained-row adapter is the measured alternative when its memory cost is
acceptable. These prototypes use one writer; schema changes and generated
columns remain outside their scope. Providing old rows avoids retaining
inputs solely to translate upserts; reactive operators may still need state.

Pursue the hook-plus-cache approach for application-independent capture of
ordinary rowid tables with stable schemas. The experiments already encode
weighted rows beside the frames and upload them together. Server integration
should rebuild the cache from recovered database state and discard speculative
state after failed publication. Extend schema/type coverage and test restart
and failure boundaries before treating the feed as generally supported.

Retain the *environment and summary*[^][0003-zset-summary] and
*raw samples (gzip JSON)*[^][0003-zset-samples].
