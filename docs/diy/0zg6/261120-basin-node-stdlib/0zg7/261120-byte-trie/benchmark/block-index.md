[block-index]: <block-index.json>

# Page trie versus leaf index

Bun 1.4.5, cold cache per point read, memory storage and zero-I/O capability
resolution. Count the block root plus navigation; omit the common volume lookup.
Compare direct traversal, explicitly fetched leaf vectors and leading/lagging
index shortcuts. The *raw traces*[~][block-index] verify returned bytes.

| Pages / bytes per page | Direct GETs first/middle/last | Index GETs | Spine GETs | Stored KiB with / without index |
|---|---:|---:|---:|---:|
| 20,000 / 1 | 1 / 2 / 2 | 1 / 2 / 2 | 1 / 2 / 2 | 39.9 / 34.6 |
| 350,000 / 1 | 1 / 2 / 2 | 1 / 3 / 3 | 1 / 3 / 3 | 658.4 / 556.1 |
| 5,000 / 4,096 | 1 / 2 / 1 | 1 / 2 / 1 | 1 / 2 / 1 | 5,701.7 / 5,700.4 |

No round-trip benefit appears here, including boundary shortcuts. The stored
350,000-page index costs about 102 KiB. Omitting it preserves GET counts and
reduces storage; the prototype exposes `{ leafIndex: false }`, retaining the
empty index shape. Production ready-only hints remain enabled by default for
compatibility with the current layout, but these measurements favor opting out.
Directory file links are separate: a ready link can bypass the device trie.

For 4 KiB values, count-based inlining makes the block root roughly 4.6 MiB;
omitting the index barely helps that. A byte-aware packing budget is a separate
candidate. An object byte limit currently rejects oversize objects; it does not
repack them automatically.
