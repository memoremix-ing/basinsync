[benchmark]: <benchmark.md>
[bromberg-sl2]: <../../../../glossary/bromberg-sl2.md>
[control-1]: <control-1.json>
[control-16]: <control-16.json>
[flexbuffers]: <../../../../glossary/flexbuffers.md>
[incremental]: <incremental.md>
[io]: <io.md>
[profile]: <profile.html>
[profile-local-1]: <profile-local-1.json>
[profile-local-16]: <profile-local-16.json>
[profile-wan-1]: <profile-wan-1.json>
[profile-wan-16]: <profile-wan-16.json>
[sha384]: <../../../../glossary/sha384.md>
[trie]: <../../../../glossary/trie.md>
[turso]: <../../../../glossary/turso.md>
[volume]: <../../../../glossary/volume.md>

# Where SyncVolume time goes

Historical measurements; the current cross-language checksum and I/O follow-up are in the *I/O comparison*[~][io].

This profiles the full-rebuild control; the *incremental comparison*[~][incremental]
describes the updated export path.

Explore the *interactive breakdown*[~][profile].

Same workload and machine as the *baseline*[~][benchmark]. Add opt-in,
calling-thread wall-time spans (`basinsync-structures/profile`); normal builds
erase them. Exclusive times subtract child spans, avoiding double counting.
Each table uses the median-time trial of three, rather than adding independent
component medians. Raw *local one-page*[~][profile-local-1],
*local sixteen-page*[~][profile-local-16], *transport one-page*[~][profile-wan-1]
and *transport sixteen-page*[~][profile-wan-16] runs include every phase.

Local changed-backup attribution after eager loading, milliseconds:

| Work | One-page packing | Sixteen-page packing |
| --- | ---: | ---: |
| *BrombergSL2*[~][bromberg-sl2] page hashing + summary combination | 319.5 | 337.6 |
| Object-adapter file/directory fsync | 150.2 | 72.5 |
| *SHA-384*[~][sha384] + HMAC | 9.2 | 8.1 |
| *FlexBuffers*[~][flexbuffers] encoding/decoding | 3.3 | 0.5 |
| Reading cached database pages | 0.7 | 0.7 |
| Remaining *trie work*[~][trie], graph bookkeeping and allocations | 27.8 | 7.2 |
| **Total** | **510.5** | **426.6** |

The exporter rehashes all 294 pages (4,816,896 bytes), despite changing one
payload and one companion counter. *SL2*[~][bromberg-sl2] recomputation consumes 63–79% here;
combining existing summaries takes only 1.1–1.4 ms. Exclusive *trie construction*[~][trie]
takes 10.6/3.4 ms; serialization is small. Reusing stored objects currently
saves uploads, not page hashing.

Seven/four new objects cause 28/16 fsync calls: each synchronizes its body,
allocation record and their parent directories. This is the disk-backed test
adapter's durability policy, not *Turso*[~][turso] checkpoint time or a prediction of S3
latency. Reading cached database pages takes less than a millisecond.

Cold primary-file opening:

| Packing / transport | Total ms | Actual modeled-wait ms | GETs |
| --- | ---: | ---: | ---: |
| One-page / local | 80.6 | ~0 | 264 |
| Sixteen-page / local | 43.7 | ~0 | 19 |
| One-page / 25 ms, 20 MiB/s | 8,872 | 8,431 | 264 |
| Sixteen-page / 25 ms, 20 MiB/s | 986 | 831 | 19 |

Without transport delays, one-page eager opening spends ~21 ms on object and
allocation reads, 13 ms on *SHA-384*[~][sha384], 21 ms decoding/validating metadata, and the
rest mainly on repeated traversal and page-cache work. Each page lookup currently
revisits file, block and *trie metadata*[~][trie]; it does not retain a file cursor.

Actual sleep wall time includes scheduler overshoot: nominal delay plus transfer
would request 6,817/693 ms in those two transport cases. Treat absolute simulated
latencies accordingly. These spans measure elapsed time, not CPU-clock samples.

Lazy opening postpones complete-file loading. At 25 ms/20 MiB/s, subsequently
hydrating and verifying both requested databases takes a median 8,764 ms with
one-page packing or 829 ms with sixteen-page packing; eager hydration/verification
is 28/26 ms. This formerly untimed phase now has its own `hydrate_all` measurement.
Warm SQL and local-commit phases perform no object GETs.

Uninstrumented controls: *one page*[~][control-1] and *sixteen pages*[~][control-16].
Eager open medians are 74.2/45.1 ms versus instrumented 80.6/43.7; backup medians
are 501.5/428.1 versus 510.5/426.6. Timing overhead and filesystem noise limit
small comparisons; the dominant costs are clear.

Prioritize retaining unchanged page summaries and incremental path-copying.
For cold loading, retain resolved file handles and *trie cursors*[~][trie], and consider bounded object
prefetch. Measure adapter durability separately before interpreting its fsync
cost as a production limitation of *SyncVolumes*[~][volume].
