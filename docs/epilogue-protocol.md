[causal-consistency]: <glossary/causal-consistency.md>
[commit-marker]: <glossary/commit-marker.md>
[conditional-read]: <glossary/conditional-read.md>
[differential-event]: <glossary/differential-event.md>
[epilogue]: <glossary/epilogue.md>
[heap-protocol]: <heap-protocol.md>
[json0]: <glossary/json0.md>
[lexidecimal]: <glossary/lexidecimal.md>
[milestone]: <glossary/milestone.md>
[node]: <glossary/node.md>
[range-get]: <glossary/range-get.md>
[reservoir]: <glossary/reservoir.md>
[sha384]: <glossary/sha384.md>
[viewpoint]: <glossary/viewpoint.md>
[watershed]: <glossary/watershed.md>
[watershed-backup]: <watershed-backup.md>

# Epilogue protocol

*CommitMarkers*[^][commit-marker] use `epilogue/Lexidecimal(~viewpoint)` keys
within each *Reservoir*[^][reservoir] namespace; see the *key layout*[^][watershed-backup].
*Viewpoints*[^][viewpoint] increase from zero; their
*encoded keys*[^][lexidecimal] decrease lexicographically.

`PUT /api/v0/epilogue` accepts multipart `details` (*JSON0*[^][json0]) and
`blob` (raw bytes). `details` contains `viewpoint: bigint` and
`sha384: Uint8Array`, plus a required `edges` array (`[]` for an empty graph), using the
*reservation API's*[^][heap-protocol] authenticated child descriptors.
Verify each referenced *node*[^][node] before accepting its edge. Require the expected
*viewpoint*[^][viewpoint] and matching *digest*[^][sha384] before accepting a
commit. Rejection must not advance the sequence.

Responses use *JSON0*[^][json0] with bigint *viewpoints*[^][viewpoint].
All `/api/v0` responses include `timelines.watershed.milestone`, a bigint identifying
their known durable *watershed*[^][watershed] *Milestone*[^][milestone] (zero before the first
*DifferentialEvent*[^][differential-event]).
Successful commits report their published batch; status reports its materialized
prefix, including when cached. A lower value than a client has already observed
reveals a *causal reverse*[^][causal-consistency] across server instances.
A *viewpoint*[^][viewpoint] mismatch returns HTTP 409:

```json
{"next":{"viewpoint":"0x1"},"timelines":{"watershed":{"milestone":"0x2"}}}
```

`GET /api/v0/epilogue/status` reports the latest committed
*CommitMarker*[^][commit-marker]:

```json
{"latest":{"viewpoint":"0x1","length":10,"url":"<presigned GET>","headers":{"If-Match":"*","Range":"bytes=128-137"}},"timelines":{"watershed":{"milestone":"0x2"}}}
```

For `latest`, send the returned `headers` with its URL, including the signed
*conditional read*[^][conditional-read] header. A
*Range GET*[^][range-get] must be cryptographically restricted to the expected
*marker*[^][commit-marker] bytes. When the matching stored
*marker*[^][commit-marker] supplies the URL, `headers` is `{"If-Match":"*"}`. For zero length,
omit `url` and `headers` and use empty bytes without fetching.

With no committed *marker*[^][commit-marker], `latest` is `null`.
