[directory-descriptors]: <directory-descriptors.json>

# Directory descriptor export

Bun 1.4.5, five alternating trials, cold reader, 100 folders × 20 files.
Compare full enumeration/rebuild with a selective file replacement in the new
contents-only layout. *Raw trials*[~][directory-descriptors] verify identical
canonical root digests.

| Path | Median ms | GETs | PUT calls | New objects |
|---|---:|---:|---:|---:|
| Full | 173 | 11 | 12 | 3 |
| Selective update | 66 | 11 | 12 | 3 |

Unchanged child contents are reused. Modified ancestor contents tries currently
repack using weighted inline costs; opaque-piece export remains limited to
ordinary trie costs. This fixture therefore saves CPU, not adapter calls.
Ancestor hashes still require immediate names and child digests. No network
latency is simulated.
