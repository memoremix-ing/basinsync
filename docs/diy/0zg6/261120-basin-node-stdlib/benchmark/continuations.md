[continuations]: <continuations.json>

# Resume or restart

Bun 1.4.5, 20,000 entries, precomputed byte keys (bigint vector indices), three
alternating trials. Each lookup starts with a fresh cache, either cold or with only
the root loaded outside timing. Restart discards its read-only generator after each
awaited load, then looks up from the root again. Both paths verify loaded objects.
The *raw measurements*[~][continuations] confirm identical GET/byte counts.

Median milliseconds; zero-delay cells contain 1,024 lookups, delayed cells 32.

| Structure | Cold resume/restart | Root-ready resume/restart | 2 ms/GET cold resume/restart |
|---|---:|---:|---:|
| Trie | 104 / 112 | 55 / 57 | 164 / 165 |
| Vector | 89 / 94 | 58 / 61 | 164 / 163 |
| B-tree | 99 / 101 | 67 / 69 | 163 / 164 |

Retained traversal wins modestly at zero injected delay; network delay overwhelms
these differences. Keep it for now, without assuming that fewer traversal steps
always win across engines, shapes or cache states. Root-ready delayed cells take
roughly 82 ms with either strategy. These are memory-adapter probes, not S3 timings.
