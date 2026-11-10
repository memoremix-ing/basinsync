[http-preconditions]: <https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.1>
[tigris-pricing]: <https://www.tigrisdata.com/pricing/>

# Conditional read

A GET or HEAD guarded by HTTP preconditions. Use `If-Match: *` for S3 reads.
Existence probes also send
`If-None-Match: *`: 304 or 200 means present; 404 or 412 means absent. Other
responses are errors. Reads needing bytes or metadata omit `If-None-Match`.

*Tigris pricing*[^][tigris-pricing] exempts 304 and 412 responses. Missing objects
can still return 404: *HTTP preconditions*[^][http-preconditions] do not guarantee
that `If-Match` takes precedence over absence.

Presigned GETs bind `If-Match` into their signature; clients must send it.
