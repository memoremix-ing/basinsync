[commit-marker]: <glossary/commit-marker.md>
[epilogue]: <glossary/epilogue.md>
[json0]: <glossary/json0.md>
[lexidecimal]: <glossary/lexidecimal.md>
[sha384]: <glossary/sha384.md>
[viewpoint]: <glossary/viewpoint.md>

# Epilogue protocol

*CommitMarkers*[^][commit-marker] use `epilogue/Lexidecimal(~viewpoint)` keys.
*Viewpoints*[^][viewpoint] increase from zero; their
*encoded keys*[^][lexidecimal] decrease lexicographically.

`PUT /api/v0/epilogue` accepts multipart `metadata` (*JSON0*[^][json0]) and
`blob` (raw bytes). Metadata contains `viewpoint: bigint` and
`sha384: Uint8Array`. Require the expected
*viewpoint*[^][viewpoint] and matching *digest*[^][sha384] before accepting a
commit. Rejection must not advance the sequence.

Responses use JSON with decimal string *viewpoints*[^][viewpoint].
A *viewpoint*[^][viewpoint] mismatch returns HTTP 409:

```json
{"next":{"viewpoint":"1"}}
```

`GET /api/v0/epilogue/status` reports the latest committed *viewpoint*[^][viewpoint]
and the most recent *CommitMarker*[^][commit-marker] stored in the
*Epilogue*[^][epilogue], with a presigned GET URL:

```json
{"latest":{"viewpoint":"1"},"recent":{"viewpoint":"0","url":"<presigned GET>"}}
```

Either field is `null` when its corresponding value is absent; both are `null`
when empty.
