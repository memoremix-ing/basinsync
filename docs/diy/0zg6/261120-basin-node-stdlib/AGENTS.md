[diy/0zg6/261120-basin-node-stdlib]: <README.md>

# Structure implementation guidance

Follow the *implementation considerations*[~][diy/0zg6/261120-basin-node-stdlib].
Apply these when implementing or benchmarking this tutorial family:

- Name the measured API and include/exclude key translation, aggregation, crypto,
  storage and export explicitly. Match snapshot guarantees; distinguish immutable
  writes from transient in-place batches.
- Isolate changes before attributing gains. Benchmark restart-from-root against
  retained continuations under matching cache/miss conditions; less apparent work
  need not run faster. Keep measured findings distinct from hypotheses.
- Distinguish logical path-copying, selective loading, canonical export and uploaded
  object reuse. None alone establishes that an operation is incremental end to end.
  Count storage-adapter calls separately from newly allocated objects.
- State ownership separately for stored bytes, logical structure, payloads, descriptors
  and borrowed views. Structural sharing and TypeScript `readonly` do not establish
  deep immutability; preserve integrity checks around cached external descriptors.
- Consider subtree split/detach/graft for range operations, avoiding descendant loads
  where possible. Keep stored headers and consumer summaries relocatable: trie bounds
  describe relative suffixes, not absolute paths. Check consumer callbacks for ancestor
  dependencies and preserve canonical packing at boundaries. Test pathname boundaries,
  destination collisions and moves into descendants.
- Rotate transient ownership before snapshots/iterators escape or subtrees are
  grafted; an owner tag alone does not prove a branch has only one parent.
- Verify shared unchanged branches, old snapshots, owned versus borrowed data,
  canonical output and cross-language reads. Record request/byte counts as well as CPU.
- Optional shortcut indexes should not add cold-path fetches merely to discover
  hints; measure ready-only navigation against direct authoritative traversal.
- Distinguish logical fanout from stored packing. Count-based inline budgets can
  over-fetch large values; measure bytes and GETs before favoring wider branches.
- Carry measured techniques across structures as candidates, then measure again;
  performance in one structure, runtime or language is not evidence for another.
- Compare explicit path updates, whole-value copies and Proxy drafts separately under
  matching snapshot/ownership rules. Count copied bytes and retained versions; test
  reflection, escaped drafts and scope lifetime before claiming ergonomic equivalence.

Byte ownership must survive subclass behavior: `Buffer.slice()` is a view. Test
Buffer-backed inputs and use copying constructors where ownership is promised.
