---
prerequisites:
  - 0zg8/261124-syncvolume-reservoir-vfs
---

[diy/0zg8/261124-syncvolume-reservoir-vfs]: <../../0zg8/261124-syncvolume-reservoir-vfs/README.md>
[lru-cache]: <../../../glossary/lru-cache.md>
[node]: <../../../glossary/node.md>
[sha384]: <../../../glossary/sha384.md>

# Basin node LRU caches

Give the *VFS's*[~][diy/0zg8/261124-syncvolume-reservoir-vfs] encoded
*basin-node caches*[~][node] an *LRU policy*[~][lru-cache] across TypeScript, Rust
and Go. Cache hits, including ready `peek` hits, refresh use time. Evict the least
recently used entries while retaining the 16 MiB/128-object defaults; bypass
oversized objects.

For the disk cache, refresh modification time best-effort after a verified read
and evict the oldest timestamps. This approximates *LRU*[~][lru-cache] across restarts; clock
changes and timestamp ties affect ordering. Keep the byte budget configurable
(128 MiB in the experiment).

Preserve *SHA-384*[~][sha384] and descriptor checks, pending-read coalescing, and
clear/eviction barriers. Each layer tracks its own use: a RAM hit need not touch
disk metadata. Active readers may retain evicted bytes.

With room for two objects, load A and B, use A again, then load C: A remains
cached and B misses. Exercise loads, peeks, byte/count limits, clearing, pending
failures, and disk reopening.
