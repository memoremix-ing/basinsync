[basin-backup]: <basin-backup.md>
[commit-marker]: <glossary/commit-marker.md>
[epilogue]: <glossary/epilogue.md>
[json0]: <glossary/json0.md>
[lexidecimal]: <glossary/lexidecimal.md>
[range-get]: <glossary/range-get.md>
[reservoir]: <glossary/reservoir.md>
[sha384]: <glossary/sha384.md>
[viewpoint]: <glossary/viewpoint.md>

# Epilogue protocol

*CommitMarkers*[^][commit-marker] use `epilogue/Lexidecimal(~viewpoint)` keys
within each *Reservoir*[^][reservoir] namespace; see the *key layout*[^][basin-backup].
*Viewpoints*[^][viewpoint] increase from zero; their
*encoded keys*[^][lexidecimal] decrease lexicographically.

`PUT /api/v0/epilogue` accepts multipart `details` (*JSON0*[^][json0]) and
`blob` (raw bytes). `details` contains `viewpoint: bigint` and
`sha384: Uint8Array`. Require the expected
*viewpoint*[^][viewpoint] and matching *digest*[^][sha384] before accepting a
commit. Rejection must not advance the sequence.

Responses use *JSON0*[^][json0] with bigint *viewpoints*[^][viewpoint].
A *viewpoint*[^][viewpoint] mismatch returns HTTP 409:

```json
{"next":{"viewpoint":"0x1"}}
```

`GET /api/v0/epilogue/status` reports the latest committed *viewpoint*[^][viewpoint]
and the most recent *CommitMarker*[^][commit-marker] stored in the
*Epilogue*[^][epilogue]:

```json
{"latest":{"viewpoint":"0x1","length":10,"url":"<presigned GET>","headers":{"Range":"bytes=128-137"}},"recent":{"viewpoint":"0x0","url":"<presigned GET>"}}
```

For `latest`, send the returned `headers` with its URL. A
*Range GET*[^][range-get] must be cryptographically restricted to the expected
*marker*[^][commit-marker] bytes. When the matching stored
*marker*[^][commit-marker] supplies the URL, `headers` is `{}`. For zero length,
omit `url` and `headers` and use empty bytes without fetching.

Either position is `null` when absent; both are `null` when empty.
