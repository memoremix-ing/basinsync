[empty-sentinel]: <empty-sentinel.md>
[envbuf]: <envbuf.md>
[etag]: <etag.md>
[flexbuffers]: <flexbuffers.md>
[promotion-sign]: <promotion-sign.md>

# Margin

A skippable format `110` *EnvBuf*[~][envbuf], distinct from the `0xee` alignment
padding between an envelope's message and footer.

Feeds default to a trailing 24-byte margin with an eight-byte `u64` message,
in *FlexBuffers'*[~][flexbuffers] little-endian order, starting at zero.
If publication returns the *empty sentinel's*[~][empty-sentinel] *ETag*[~][etag],
increment and replace that same margin until distinct, without a retry limit;
never wrap the counter.
Preserve the feed prefix and retry with `If-Match` on the observed validator.

Standalone margins instead contain one `u8`, counting from 1 through 7.
Probe these values at startup; terminate if none has a distinct *ETag*[~][etag].
Use the selected margin for *PromotionSigns*[~][promotion-sign], advancing its counter
within the same bounds if publication collides. All remain 24 bytes with default alignment.
