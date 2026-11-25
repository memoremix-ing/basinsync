[page-spines]: <page-spines.json>

# Direct page spines

Bun 1.4.5; 50,000 unique four-byte pages, cold whole-volume point reads, memory
storage and zero-I/O hint resolution. Counts include directory/block metadata.
The *raw traces*[~][page-spines] retain warm repeats, bytes and resolver calls.

| Key range / degree limit | Early GETs direct → spine | Middle | Last |
|---|---:|---:|---:|
| Starts at zero / 320 (default) | 2 → 2 | 3 → 3 | 2 → 2 |
| Starts at zero / 32 | 2 → 2 | 4 → 4 | 3 → 3 |
| Starts at 65,536 / 320 | 3 → 3 | 3 → 3 | 2 → 2 |
| Starts at 65,536 / 32 | 4 → 3 | 4 → 4 | 3 → 3 |

The deeper shifted case saves one GET for sampled early pages (offsets 0, 1 and 15) and reduces
transfer from 17,440 to 11,400 bytes. Its root carries two leading targets; the
lowest stored target skips an intermediate object. Zero-based early pages are
already inline, so hints add no fetches and offer no GET savings there. All warm
repeats use zero GETs. No network latency is simulated; resolver I/O would be an
additional cost.

Directory descriptors and file edges form the authoritative retention graph.
The block has only its page trie and weak boundary spines; no separate index is
loaded. Stale/malformed hints fall back to that graph.
