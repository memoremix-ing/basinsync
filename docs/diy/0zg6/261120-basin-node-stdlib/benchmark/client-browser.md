[client-browser]: <client-browser.json>

# Browser logical editing

Headless Chromium 156 on macOS; five alternating trials in one browser context.
20,000 precomputed three-byte keys; vector uses five-bit branching and converts
indices to bigint inside timed loops. Generic numeric values. No storage,
aggregation, crypto or export. The *raw measurements*[~][client-browser] include
all trials; these are diagnostic single-process CPU measurements.

| Logical structure | Build ms | 10,000 persistent replacements ms | 100,000 reads ms |
|---|---:|---:|---:|
| Byte trie | 8.1 | 8.4 | 31.4 |
| Bitmap vector | 5.3 | 3.2 | 21.5 |
| B-tree | 8.0 | 5.4 | 27.8 |

Old roots are retained and checked after edits. Each structure uses its own input
construction path; this is an API comparison, not an isolated branching-factor
experiment. The Rust structures also compile for `wasm32-unknown-unknown`; Wasm CPU
has not been measured, nor have native logical editors been added.
