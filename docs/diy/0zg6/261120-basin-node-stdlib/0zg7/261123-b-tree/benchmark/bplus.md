[bplus]: <bplus.json>

# B-tree versus B+tree

Bun 1.4.5, generic numeric values, memory storage. Three alternating trials;
build includes aggregation, crypto and PUTs. Warm CPU is 100,000 owned-value
reads over 64 keys, with zero GETs verified. Cold averages use 32 deterministic
keys, a fresh cache per read. *Raw measurements*[~][bplus] include policies and
first/middle/last probes with and without weak boundary hints.

At 100,000 entries; sizes are average fetched KiB per cold read:

| Layout | Warm ms | Cold GETs | KiB |
|---|---:|---:|---:|
| B-tree | 157 | 2 | 41.4 |
| B+ 31-pair leaves / 32 children | 182 | 2 | 45.3 |
| B+ 127-pair leaves / 128 children | 250 | 3 | 37.5 |
| B+ 1,023-pair leaves / 128 children | 179 | 2 | 40.2 |
| B+ 31-pair leaves / 128 children, 4,096 inline values | 176 | 2 | 69.6 |

The 1,023-leaf variant builds in 44 ms versus 79 ms for B-tree. Raising only the
routing budget from 1,280 to 8,192 changes neither GETs nor bytes in these fixtures:
the value/degree limits bind first. With 31-pair leaves, increasing fanout from
32 to 128 adds a stored level; allowing 4,096 inline values removes it at the cost
of more fetched bytes. Logical fanout alone does not determine round trips.

For 5,000 values of 4,096 bytes, one cold transfer trace gives:

| Layout | GETs | KiB |
|---|---:|---:|
| B-tree | 2 | 4,035 |
| B+ 31 / 128 | 2 | 176 |
| B+ 127 / 128 | 2 | 515 |
| B+ 1,023 / 128 | 2 | 4,017 |

Smaller B+ leaves save bandwidth for large values while retaining two GETs here;
that is a packing tradeoff, not an inherent advantage of leaf-only values. Node
budgets count values/keys, not bytes. B-tree's own separator values can answer
without descending; the middle-key probes happen to hit such separators.

Boundary hints turn three GETs into two at the ends of the less favorable B+
layouts; they do not improve their middle reads or beat the two-GET B-tree path.
Hint resolution has no I/O in this experiment. No network latency is simulated.

Keep B-tree for general compact maps. Retain B+tree as an explicit alternative
for large-value/range workloads, with measured leaf budgets. Confidence is high
in these local counts, moderate in generalizing the recommendation. The prototype
has build/read/range support; logical edits and native B+ readers are not included.
