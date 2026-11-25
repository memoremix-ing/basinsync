[empty-sentinel]: <empty-sentinel.md>
[envbuf]: <envbuf.md>
[etag]: <etag.md>
[http-preconditions]: <https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.1>
[tigris-pricing]: <https://www.tigrisdata.com/pricing/>
[tombstone]: <tombstone.md>

# Conditional read

A GET or HEAD guarded by HTTP preconditions. Use `If-Match: *` for S3 reads.
Sequence probes also send `If-None-Match: <bucket empty-reference ETag>`:
304 means the *ETag*[~][etag] matches the empty reference, so treat the position
as an exclusive search bound, but read its length without `If-None-Match`
before replacing it, since a publication in progress can share that
*ETag*[~][etag] (see *empty sentinel*[~][empty-sentinel]); 200 requires checking length:
zero is still a sentinel, positive lengths below the sixteen-byte *EnvBuf*[~][envbuf]
floor may be *tombstones*[~][tombstone], and data entries require framing.
Validate short objects against the bucket-proven representation. 404 or 412 means
absent. *Sentinels*[~][empty-sentinel] bound the unpublished tail;
*tombstones*[~][tombstone] occupy older positions
without becoming replayable data. Other responses are
errors. Reads needing bytes or metadata omit `If-None-Match`.

*Tigris pricing*[~][tigris-pricing] exempts 304 and 412 responses. Missing objects
can still return 404: *HTTP preconditions*[~][http-preconditions] do not guarantee
that `If-Match` takes precedence over absence.

Presigned GETs bind `If-Match` into their signature; clients must send it.
