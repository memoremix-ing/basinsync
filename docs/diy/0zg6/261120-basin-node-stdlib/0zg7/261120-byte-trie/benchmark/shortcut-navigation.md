[page-spines]: <page-spines.md>
[shortcut-navigation]: <shortcut-navigation.json>
[shortcut-reads]: <shortcut-reads.md>

# Paged metadata and ready-only hints

Historical measurements of the prior device/leaf-index layout; see the current
*page-spine measurements*[~][page-spines].

Bun 1.4.5, in-memory storage, cold cache for each point read; one-byte pages isolate
routing. These are request/byte counts, not network timings. The *raw traces*[~][shortcut-navigation]
include warm repeats and source digests. Compare the *initial traces*[~][shortcut-reads].

| Fixture | First/middle/last GETs | Fetched bytes |
|---|---:|---:|
| 20,000 pages | 2 / 3 / 3 | 37,192 / 41,256 / 38,000 |
| 350,000 pages | 2 / 3 / 3 | 569,472 / 573,536 / 570,520 |
| 5,000 files | 3 / 3 / 2 | 270,080 / 270,080 / 220,136 |

Enabling hints produces the same counts; all warm repeats use zero GETs.
Ready-only navigation avoids the old leaf-index penalty (6/6/7 GETs for the
350,000-page fixture). Paged directories reduce the sampled wide-directory point
read from roughly 1 MiB to 270 KiB. Keeping the device root inline when it fits
avoids another GET. This is not evidence that every hint improves latency: the
resolver here performs no I/O, and a large block root still contributes transfer.
