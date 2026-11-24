[editor-reads]: <editor-reads.json>

# B-tree editing and warm reads

Bun 1.4.5; 20,000 four-byte keys, generic numeric values, synchronous null
aggregation, memory storage. Five alternating trials in one process; medians below.
Build includes packing, cryptography and storage calls; warm reads include value
conversion and input ownership. The *raw measurements*[~][editor-reads] retain every trial.

| Variant | Build ms | 100,000 warm `get` ms | Ready `getOrDefer` ms |
|---|---:|---:|---:|
| Before lookup changes | 19.7 | 1,988 | — |
| Only avoid awaits of synchronous callbacks | 16.8 | 1,975 | — |
| Cached plans + ready traversal | 17.7 | 156 | 140 |

Most read improvement comes from the combined cached-plan/ready-traversal change;
this experiment does not isolate those two mechanisms from each other. The
ready public API saves another roughly 10%. Build differences are small/noisy.
Stored bytes and branching factor are unchanged.

10,000 persistent replacements took 7.9 ms; retaining snapshots by copying a
20,000-entry Map each time took 1,229 ms. This comparison includes the Map's
string-key conversion/initial construction; it is a coarse reference, not a
controlled attribution. Neither edit loop aggregates, serializes, hashes or stores.
Logical edits path-copy; loading an editor materializes the tree, and export still
rebuilds its canonical representation. Do not treat cheap edits as selective export.
