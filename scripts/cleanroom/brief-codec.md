# Clean-room rebuild of the basinsync codecs

This repository holds only the basinsync documentation in `docs/`. Rebuild
basinsync's codecs from that documentation alone, prove them with Kani, and
expose them through an oracle CLI, so we can learn whether the codec
documentation is complete and correct. The result may become the codec kit
that later server rebuilds start from.

You work unattended: nobody will answer questions. When the documentation is
ambiguous, silent, or contradictory, make the most reasonable choice, record it
as a gap, and keep going.

## Rules

- `docs/` is the only source of requirements. Do not look for, fetch, or read
  any other basinsync code, repository, issue, or discussion; that would
  invalidate the experiment. Package registries and documentation for your
  tools (Rust, Kani) are fine.
- Do not edit `docs/`. Everything you write lives outside it.
- Scope is the codecs, not the server. Read whatever you need, starting with
  the glossary entries for Lexidecimal, Diffuse16, EnvBuf, margins,
  FlexBuffers, JSON0, CRC32C and SHA-384, and the object-key reference and
  Flow id rules.
- Your build will later be checked against independent test vectors you
  cannot see. Follow the documentation exactly.
- Commit to git often with clear messages. There is no remote; do not add one.

## Deliverables

Use exactly this layout, so the result can be reused as is:

1. **`GAPS.md`, the primary deliverable.** One entry per gap: an id, the
   documentation file and line(s), the kind (omission, ambiguity,
   contradiction, or error), what is missing or unclear, the assumption you
   made, and what it affects. Also note documentation you found sufficient
   for tricky parts.
2. **`crates/codec`**, package `basinsync-codec`: Lexidecimal (including size
   prefixes), Diffuse16, EnvBuf feeds and margins, the FlexBuffers extensions,
   JSON0, CRC32C, SHA-384 hex, object-key prefixes, and Flow id normalization,
   with unit and property tests. Keep its dependencies few; it should suit a
   server that depends on it by path.
3. **Kani proofs** in `crates/codec` (`cargo kani -p basinsync-codec`): no
   panics on arbitrary input up to a bound; round-trips (decode of encode
   returns the value, and encode of a decoded canonical string returns that
   string); rejection of noncanonical encodings. Where CBMC struggles,
   prove allocation-free cores that the public API wraps. Record every
   harness's property, bound, result, time, and peak memory in
   `crates/codec/KANI.md`, with what Kani found.
4. **`crates/oracle`**, binary `basinsync-oracle`: the oracle CLI described in
   `ORACLE-INTERFACE.md`, built on `basinsync-codec`. It defines only the
   interface, not expected results.
5. **`scripts/kani-all.sh`**: runs the harnesses one at a time, each under a
   timeout and a memory cap, writing one result line per harness.
6. **`README.md`** explaining how to build, test, and prove everything.

## Status and blockers

Keep `STATUS.md` current and commit it with your work: the phase you are in,
what is done, what is next, and anything blocking you. Start each blocking
problem's line with `BLOCKED:` and say what you tried; the people running the
rebuild watch for those lines. If you cannot make further progress, write the
blockers, commit, and stop rather than looping.

## Resources

Everything you start shares one memory cap, `$CLEANROOM_MEMORY_MAX`; exceeding
it kills the largest process. Kani's model checker can consume all of it:

- run one Kani job at a time, never several in parallel or in background
  helpers;
- wrap each in `timeout` and a memory limit (for example
  `ulimit -v 16000000; timeout 900 cargo kani -p basinsync-codec --harness NAME`),
  start with small bounds, and grow them only while runs stay well under the cap;
- treat an out-of-memory kill or timeout as a reason to shrink the bound or
  split the harness, and record the bound you settled on.

## Environment

Rust stable with Cargo, Kani (`cargo kani`), and a C toolchain (`cc`) are on
`PATH`. You run inside a sandbox: you can read and write this repository and
your tool caches, nothing else on the machine. Network access is limited to
the model API, package registries, and tool documentation. If something you
need is blocked, record it in `GAPS.md` and work around it.
