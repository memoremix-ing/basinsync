[0003-s3-latency-samples]: <data/0003-s3-latency-samples.gz>
[0003-s3-latency-summary]: <data/0003-s3-latency-summary.json>
[0003-snapshot-readers]: <0003-snapshot-readers.md>
[0003-turso-basin-vfs]: <../diy/0003-turso-basin-vfs.md>
[conditional-write]: <../glossary/conditional-write.md>
[flow]: <../glossary/flow.md>
[physical-frame]: <../glossary/physical-frame.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[virtual-file-system]: <../glossary/virtual-file-system.md>
[z-set]: <../glossary/z-set.md>

# 0003 S3 latency — 2026-10-24

At measurement time, the HTTP server batched serially, waiting for publication
before preparing the next batch. The *0003 server*[^][0003-turso-basin-vfs] now
uses two batches. This experiment connects the
*copy-on-write VFS*[^][virtual-file-system] from the
*snapshot-reader prototype*[^][0003-snapshot-readers] to three bounded stages:

```text
prepare + checkpoint → query pinned views → encode + ordered conditional PUT
```

An admission limit of one serializes the stages; limits two/four allow
preparation and *Z-set*[^][z-set] construction ahead of publication. Only one
*conditional PUT*[^][conditional-write] runs at a time. Success releases admission
only after that PUT succeeds. Pin history until view queries finish; retain
the resulting owned row feed through publication.

Add 0/25/100/250 ms inside each event's publication phase before its real S3
request. This is additional to the endpoint's own latency. Upload the seed and
read back every subsequent stored event outside timing.

## Results

Median requests/s, 32 requests/batch:

| Added PUT delay | Serial | Limit 2 | Limit 4 |
| --- | ---: | ---: | ---: |
| 0 ms | 899 | 1,042 | 1,012 |
| 25 ms | 431 | 519 | 501 |
| 100 ms | 200 | 217 | 213 |
| 250 ms | 103 | 110 | 107 |

Limit two improves throughput by about 16%, 20%, 9%, and 7%, respectively.
Four offers no further gain here. At +250 ms, single-request batches reach only
3.47/3.57/3.57 requests/s at limits one/two/four. Batching remains the larger gain.

Preparing ahead hides preparation behind S3 waiting; it cannot hide an ordered
PUT behind another PUT. The optimistic ceiling is `batch size / PUT time`.
Increasing network delay makes that publication bottleneck dominate.

At +100 ms and batch size 32, admitted-to-ack p50 is 161/295/599 ms for limits
one/two/four. Larger windows admit more queued work in this saturated benchmark.
These are not latency comparisons at the same arrival rate; admission wait is
recorded separately. The earlier local results did not justify a general claim
that pipelining intrinsically hurts request latency.

## Method and interpretation

72 runs: three rotated rounds, two batch sizes, three admission limits, four
delays; four warmup and 24 measured batches each. Optimized Rust 1.92.0,
Apple M2/24 GiB, shared SSD and warm caches; 8,192 *Flows*[^][flow] with an
additional 1 KiB stored blob per row and 4 KiB request blobs. *Turso*[^][turso]
uses 16 KiB pages, `synchronous=FULL`, default plain `fsync`, and 2 MiB page
caches; copy-on-write history is unsynchronized scratch storage. Endpoint:
local `go-faster/fs v0.15.0` with real *conditional writes*[^][conditional-write].

Every run reads back all 28 event objects, verifies predecessor linkage and
native *physical frames*[^][physical-frame], reconstructs the exact primary file,
and folds the emitted *Z-sets*[^][z-set] to SQL state. Paused-publication and
lost-reply tests also cover the *VFS*[^][virtual-file-system] path. Preparation,
feed construction, encoding and publication are timed; verification is not.
Small differences on this shared host remain exploratory.

This isolates PUT waiting, excluding HTTP, refresh GETs, bandwidth limits and
latency jitter. It does not measure deployed server throughput. Keep batching
and use two admitted batches, now adopted in the server; test variable
preparation and network tails before choosing a deeper window. The on-disk
*VFS*[^][virtual-file-system] and its durable snapshot catalog remain separate
runtime work. Retain the
*environment and summary*[^][0003-s3-latency-summary] and
*raw samples*[^][0003-s3-latency-samples].
