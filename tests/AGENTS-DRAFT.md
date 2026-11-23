[dodds]: <https://kentcdodds.com/blog/write-tests>
[dowling]: <https://x.com/henrytdowling/status/2095200330166227286>
[larah]: <https://blog.larah.me/test-slop/>
[sazabi]: <https://x.com/shcallaway>

# Test-suite guidance (draft)

Tests pin contracts that outlive redesigns, not the current shape of the code.
Fewer, stronger tests beat exhaustive coverage of incidental paths.

## Write

- **Test at the edges.** Drive public interfaces: the HTTP server, fixture
  binaries in `examples/`, encoded bytes, S3 objects. Use VersityGW, temp
  directories and in-process stubs; avoid mocks and tests of private helpers.
- **State invariants as properties.** Prefer one `proptest` or randomized
  check over a pile of examples: encode/decode round-trips, ordering,
  first-writer-wins, recovery equal to uninterrupted state, rejected input
  leaves state unchanged.
- **One scenario per setup.** Where tests repeat a setup to check one fact
  each, merge them and comment each assertion's intent; give assertions
  messages so a failure still says what broke.
- **Assert contracts, not incidentals.** Avoid exact error strings, log text,
  call counts, internal layouts and timing unless they are the interface.
- **Prove the test can fail.** Coverage is not evidence: generated suites
  reach 100% and still miss defects. Break the behavior once and watch the
  test go red.

## What history taught

Test names were durable; bodies were rewritten by renames of domain terms,
object-key layouts and wire formats. Invariants (round-trips, replay at every
prefix, recovery equal to genesis replay, atomic rejection) survived intact.

- **One source for layouts and vectors.** Object-key prefixes and codec wire
  vectors live in `tests/vectors/*.json`; Rust and TypeScript tests both read
  them, so a rename is one edit and the implementations must agree.
- **Don't count incidental structure.** Exact envelope counts, byte offsets
  and listing sizes broke on format changes; assert the contract instead.
- **Wait, don't sample.** VersityGW's POSIX backend lists in-flight
  `.sgwtmp` objects; after background writes, poll with `eventually` before
  counting listings.
- **Experiments are not tests.** Record results under `docs/`; keep prototype
  code out of the default suite.

## Keep

- Regression tests for specific bugs, named or commented with the bug.
  Committed `proptest-regressions/` seeds stay.
- Focused unit or property tests where logic is dense and edge tests reach it
  poorly: codecs, checksums, Lexidecimal, EnvBuf framing, WAL parsing. Edge
  tests alone leave such branches uncovered.

## Delete

- Tests already implied by an integration suite or a property.
- Tests that restate the implementation or pin private helpers.
- Code that exists only to satisfy a deleted test: test-only hooks and
  over-exposed internals.
- Before finishing, delete as much as possible, then rerun `scripts/check.sh`.

## Measure

Report test count, test lines, suite runtime and coverage before and after
(`cargo nextest run` for timings, `cargo llvm-cov nextest` for coverage).
Count and lines should drop; the invariants covered must not. Dependencies
build optimized in dev, so keep property strength and scale it with
`PROPTEST_CASES` rather than shrinking cases for speed.

## Sources

*Preventing LLM unit test spam*[~][larah] (test at the edges, more coverage
per test); *Write tests*[~][dodds] ("not too many, mostly integration");
*Henry Dowling's de-slop practices*[~][dowling] (delete useless tests, then
the code they propped up; aim at a size metric); *Sazabi's unit-test
deletion debate*[~][sazabi] (unit tests lock in sloppy code and cost CI
time and tokens; the counterpoint is that edge tests miss internal branches).
