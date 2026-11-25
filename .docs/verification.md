[epilogue-compaction]: <../docs/glossary/epilogue-compaction.md>
[promotion-sign]: <../docs/glossary/promotion-sign.md>
[retainer]: <../docs/glossary/retainer.md>
[tombstone]: <../docs/glossary/tombstone.md>
[verus]: <https://github.com/verus-lang/verus>
[young-generation]: <../docs/glossary/young-generation.md>

# Verification notes

Tests and Quint models check behavior; neither proves the Rust implementation.
Keep these options in mind as the riskiest pieces arrive.

## Verus for destructive Heap and Epilogue operations

Two operations delete data, and their safety rests on interleavings that
tests sample poorly: sweeping the *young generation*[~][young-generation]
once CommitMarkers publish, and *Epilogue compaction*[~][epilogue-compaction].
When hardening either, consider *Verus*[~][verus] to prove the implementation
refines a small state machine, in the IronFleet style, rather than only
testing it. Candidate invariants:

- a young-generation object is never deleted while any *retainer*[~][retainer]
  edge or retained CommitMarker graph still reaches it, and never before its
  own outgoing edges are durably removed;
- compaction never replaces a CommitMarker at or after the retained Viewpoint;
- a *PromotionSign*[~][promotion-sign] whose marker became a
  *tombstone*[~][tombstone] is always removed, whether compaction or publication
  wins the race;
- LISTers never select a snapshot whose marker was compacted.

Verus requires writing the verified core in its Rust dialect with proof
annotations, so scope it to the sweeper or compaction planner behind a narrow
interface to the rest of the server. Model the same protocol in Quint first;
the Quint invariants become the Verus specification.
