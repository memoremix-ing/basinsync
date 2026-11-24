[owned]: <owned.json>

# Vector owned mutation

Bun 1.4.5; 100,000 slots, 16,384 replacements, five alternating trials. Each burst
revisits eight neighboring slots; retain a snapshot per batch. No aggregation,
crypto, storage or export. *Raw trials*[~][owned] include copy/slot counters.
Median milliseconds:

| Bits | Batch | Persistent | Owned |
|---|---:|---:|---:|
| 5 | 1 | 10.3 | 14.5 |
| 5 | 64 | 9.4 | 4.8 |
| 5 | 1,024 | 8.5 | 4.4 |
| 7 | 1 | 27.1 | 30.3 |
| 7 | 64 | 24.9 | 19.7 |
| 7 | 1,024 | 26.7 | 21.2 |

Owned scopes help repeated edits sharing paths; single-write scopes cost more.
Keep them explicit. Growth retains private paths; shrinking currently uses the
persistent trim path. Payload ownership remains borrowed and immutable.
