# Clean-room rebuild of basinsync

This repository holds only the basinsync documentation in `docs/`. Rebuild
basinsync from that documentation alone, so we can learn whether it is complete
and correct. Start with `docs/README.md`.

You work unattended: nobody will answer questions. When the documentation is
ambiguous, silent, or contradictory, make the most reasonable choice, record it
as a gap, and keep going.

## Rules

- `docs/` is the only source of requirements. Do not look for, fetch, or read
  any other basinsync code, repository, issue, or discussion; that would
  invalidate the experiment. Package registries and documentation for your
  tools (Rust, Quint, Kani, S3) are fine.
- Do not edit `docs/`. Everything you write lives outside it.
- `vendor/turso` is the upstream Turso source at the revision the
  documentation pins, provided because GitHub is unreachable. It is a
  third-party dependency, not basinsync code: depend on `vendor/turso/core` by
  path, read it freely, and do not edit it. Materialize state in Turso as the
  documentation requires; do not substitute another store.
- `vendor/basinsync-codec` is a codec kit from an earlier clean room built
  from these docs: Lexidecimal, Diffuse16, EnvBuf, FlexBuffers extensions,
  JSON0, CRC32C, SHA-384 hex, object keys, Flow ids, and the oracle CLI, with
  Kani proofs already checked (`crates/codec/KANI.md`). Depend on
  `vendor/basinsync-codec/crates/codec` by path instead of rewriting codecs,
  and do not edit it. It decodes only FlexBuffers extensions: read whole
  documents with a FlexBuffers library after `layout::check_layout`. Where it disagrees with the docs, the docs win: record
  a gap and wrap or work around the kit.
- Your build will later be checked against independent tests you cannot see.
  Follow the documentation exactly; do not invent behavior to make things
  "work" without logging the gap that forced it.
- Stored message formats are specified in CDDL (`docs/message-schemas.md` and
  the `cddl` blocks beside each message); check what your server writes against
  them, for example with the `cddl` crate.
- Commit to git often with clear messages. There is no remote; do not add one.

## Deliverables

1. **`GAPS.md`, the primary deliverable.** One entry per gap: an id, the
   documentation file and line(s), the kind (omission, ambiguity,
   contradiction, or error), what is missing or unclear, the assumption you
   made, and what it affects. Also note documentation you found sufficient
   for tricky parts. Keep it current as you work.
2. **Quint specifications** in `specs/`, written from the documentation:
   - Epilogue commits with conditional, first-writer-wins writes;
   - the Basin Timeline: racing writers, ordering, and recovery;
   - the Heap: reservations, staging, sweeping the young generation after
     CommitMarkers publish, and reclamation safety (nothing deleted while
     still retained).
   State invariants and witnesses (reachability checks). Check them with
   `quint typecheck`, `quint run --invariant=...`, and, where the state space
   allows, `quint verify` (Apalache, bounded).
3. **A Rust implementation** of every tutorial in a Cargo workspace, with the
   documented HTTP API, S3 object layout, configuration, shutdown behavior, and
   metrics, runnable against an S3-compatible endpoint such as VersityGW as
   `docs/development.md` describes, using the codec kit. That includes Epilogue commits, the Basin Timeline, the materialized state in
   Turso with its logical and physical frame deltas,
   the Heap (shallow and deep, with cleanup, marking, and promotion), Basin
   backups and recovery, KernelSpace backup nodes and their promotion, the
   Analogue BulkOrders and accelerated recovery, and observability. Earlier
   rebuilds skipped backups and Analogue and replaced Turso; do not. If time runs short, finish in
   that order and record what remains in `STATUS.md`.
4. **Model-based tests** with the `quint-connect` crate, replaying Quint traces
   against the Rust core and comparing state at every step.
5. **`README.md`** explaining how to build, run, and test everything, and what
   is incomplete.
6. **Server configuration** for running your server against any S3 endpoint:
   document in `README.md` the environment variables for the endpoint, bucket,
   region, credentials, and listen address, so external test suites can start
   it.

## Status and blockers

Keep `STATUS.md` current and commit it with your work: the phase you are in,
what is done, what is next, and anything blocking you. Start each blocking
problem's line with `BLOCKED:` and say what you tried; the people running the
rebuild watch for those lines. If you cannot make further progress, write the
blockers, commit, and stop rather than looping.

## Resources

Everything you start shares one memory cap, `$CLEANROOM_MEMORY_MAX`; exceeding
it kills the largest process. Model checkers can consume all of it:

- run one Apalache job at a time, never several in parallel or in
  background helpers;
- wrap each in `timeout` (for example `timeout 900 quint verify ...`),
  start with small bounds (`--default-unwind`, `--max-steps`), and grow them
  only while runs stay well under the cap;
- treat an out-of-memory kill or timeout as a reason to shrink the bound or
  split the harness, and record the bound you settled on.

## Environment

Rust stable with Cargo, Kani (`cargo kani`), the Quint CLI (`quint`, with
Apalache cached), Java, Node.js, Bun, Go, a C toolchain (`cc`), and VersityGW
v1.11.0 (`versitygw`) are on `PATH`. You run inside a
sandbox: you can read and write this repository and your tool caches, nothing
else on the machine. Network access is limited to the model API, package
registries (crates.io, npm, the Go module proxy), and tool documentation. If
something you need is blocked, record it in `GAPS.md` and work around it.
