[diy/0zg9/261121-durable-test-suites]: <../../../0zg9/261121-durable-test-suites/README.md>

# Standard-library test audit

Apply the *durable test-suite guidance*[~][diy/0zg9/261121-durable-test-suites]
after rebasing onto its changes. Keep ownership, pruning, canonical packing,
malformed-input and filesystem regressions; remove instrumentation-only and
repeated empty-spine examples.

Unit-test source: 5,049 → 5,020 lines; TypeScript cases: 105 → 103.
Rust integration-test functions (15) and Go tests (15) are unchanged.
These counts exclude benchmark drivers and the interoperability harness.

Share SL2 known answers and packing-boundary selections across all three languages.
Use the shared object-key prefixes and completed-upload listing helper. Trie and
vector transients must match independent Map models, including retained snapshots,
holes, undefined values and resizing. An isolated mutation that skips transient
vector deletion fails the sparse Map test; the original implementation passes.

Every language's fixture writer is read by every language's reader. Check each
result against an independent contents model as well as cross-language agreement;
add reproducible generated trie, B-tree and sparse-vector cases. `PROPTEST_CASES`
scales those generated cases; save their inputs with failure artifacts.

The complete TypeScript suite took 9.56 s before and 7.96 s after (206 → 205 tests,
including codec tests outside the stdlib). These individual runs are validation
timings, not a controlled performance comparison. Line coverage was not measured;
the model, mutation and interoperability checks provide the correctness evidence.

Compare schemas by declaration name while preserving each declaration's token order.
Reordering declarations passes; changing the edge-kind discriminator fails.

A browser-bundle regression rejects filesystem-backed fixture loading; statically
importing the shared JSON preserves both browser loading and the common vectors.
