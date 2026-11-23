# Test-suite measurements — 2026-11-21

Rust 1.99.1 on one 16-thread Linux host with ZFS storage; `cargo nextest` wall
time for the Rust suite and `cargo llvm-cov` line coverage of production
sources from Rust tests alone (the TypeScript suites exercise the server
binary separately).

| Measure | Before | After |
|---|---|---|
| Rust `#[test]` functions | 118 | 92 |
| Rust test lines, including test-only modules | ~9,250 | ~4,600 |
| Rust suite wall time | 213 s | 13 s |
| Production lines covered by Rust tests | 63.6% | 63.3% |
| TypeScript unit tests | 42 | 39 |

The coverage change is the deleted test-only hooks plus one forwarding method
now reached only through the integration suites. Most of the runtime came from
an unoptimized Turso build; every property keeps its original case count.

The integration suite's Analogue archive count failed in two of three runs on
ZFS before the fix and passed three of three after it.
