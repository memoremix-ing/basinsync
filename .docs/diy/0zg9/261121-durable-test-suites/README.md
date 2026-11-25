---
prerequisites:
  - 0zg8/261119-observability
---

[benchmark]: <benchmark/benchmark.md>
[development]: <../../../development.md>
[diffuse16]: <../../../../docs/glossary/diffuse16.md>
[diy/0zg2/261023-turso-reservoir-vfs]: <../../../../docs/diy/0zg2/261023-turso-reservoir-vfs/README.md>
[envbuf]: <../../../../docs/glossary/envbuf.md>
[flexbuffers]: <../../../../docs/glossary/flexbuffers.md>
[flow]: <../../../../docs/glossary/flow.md>
[lexidecimal]: <../../../../docs/glossary/lexidecimal.md>
[margin]: <../../../../docs/glossary/margin.md>
[object-keys]: <../../../../docs/object-keys.md>
[timeline]: <../../../../docs/glossary/timeline.md>

# Durable test suites

Keep the test suites tight, focused, and durable. Audit the repository history:
find past redesigns, the invariants that survived them, and tests that were
brittle or rewritten, and let that shape the suite. Trim the fat. Prefer fewer
property-based invariant tests over many examples, but keep tests written for
specific regressions.

Test names proved durable; bodies were rewritten by renames of domain terms,
*object-key layouts*[~][object-keys], and wire formats. Invariants such as
round-trips, replay at every prefix, recovery equal to genesis replay, and
atomic rejection survived with mechanical edits. So:

- Hold codec vectors and key prefixes in one table read by both the Rust and
  TypeScript tests: *Lexidecimal*[~][lexidecimal], *Diffuse16*[~][diffuse16],
  *Timeline*[~][timeline] keys, *FlexBuffers*[~][flexbuffers] extensions,
  *EnvBuf*[~][envbuf] frames, *Flow*[~][flow] IDs, and object-key prefixes.
  Each implementation must accept and reject exactly the shared cases.
- State repeated examples as properties. Trailing retry *margins*[~][margin]
  never change an entry's coordinate bytes, digest, ranges, CRC32C, or recovery.
- Assert contracts, not incidental structure such as frame counts or initial
  counter bytes.
- Never count or fetch listed objects while uploads may be in flight: VersityGW
  lists incomplete PUTs as temporary objects. List completed keys, poll, or
  stop the server first.
- Keep prototype experiments out of the default suite. The
  *Turso Reservoir VFS*[~][diy/0zg2/261023-turso-reservoir-vfs] benchmark pages
  retain their results; their harness is removed.
- Don't weaken properties for speed. Build dependencies optimized for tests and
  let `PROPTEST_CASES` deepen a run.

Move the TypeScript clients under `tests/clients/`; they are test drivers.
Draft agent guidance beside the tests before adopting it. Record before/after
counts, runtime, and coverage in the *measurements*[~][benchmark], prove new
tests fail when behavior breaks, and run the *development checks*[~][development].
