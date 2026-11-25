[lexidecimal]: <../../../../glossary/lexidecimal.md>
[packing-shapes]: <packing-shapes.json>
[trie]: <../../../../glossary/trie.md>

# Consecutive page keys

Each *Lexidecimal key*[~][lexidecimal] identifies one 16 KiB page. Ordinary
*trie packing*[~][trie] chooses object boundaries; 1,280 is its inlining trigger,
not a guaranteed page count per object. Tighter one-/sixteen-page budgets are
optional VFS experiments.
Page-index keys live inside encoded nodes; they are not object-storage keys.

Measured the ordinary TypeScript serializer with count aggregation and scalar
values, without application edges or weighted inlining. Payload size affects
bytes, not this count-based layout.
The tested shapes fit the object-byte limit with 16 KiB pages.
*Raw shapes*[~][packing-shapes] include all stored objects, including index-only
objects, for thirty runs:

| Consecutive key count | Objects for keys 0…n−1 | Objects for keys 1…n |
| --- | ---: | ---: |
| 256 | 1 | 1 |
| 1,280 | 1 | 1 |
| 1,281 | 4 | 4 |
| 1,536 | 4 | 7 |
| 4,096 | 16 | 16 |

At 1,281 keys starting from zero, populated objects hold 16, 240 and 1,025
values. Starting at 65,536 instead gives five 256-value objects, a one-value
trailing object and an index root. At 4,096 keys starting at zero, all sixteen
objects inline 256 values. Some index objects also inline leading/trailing data.

One-based keys showed no compactness benefit in the tested boundaries, so the
VFS retains zero-based keys; SQLite page 1 maps to key 0.
