[basin]: <glossary/basin.md>
[causal-consistency]: <glossary/causal-consistency.md>
[commit-marker]: <glossary/commit-marker.md>
[conditional-read]: <glossary/conditional-read.md>
[context]: <glossary/context.md>
[differential-event]: <glossary/differential-event.md>
[envbuf]: <glossary/envbuf.md>
[flow]: <glossary/flow.md>
[heap-protocol]: <heap-protocol.md>
[json0]: <glossary/json0.md>
[lexidecimal]: <glossary/lexidecimal.md>
[milestone]: <glossary/milestone.md>
[node]: <glossary/node.md>
[object-keys]: <object-keys.md>
[range-get]: <glossary/range-get.md>
[reservoir]: <glossary/reservoir.md>
[sha384]: <glossary/sha384.md>
[viewpoint]: <glossary/viewpoint.md>

# Epilogue protocol

*CommitMarkers*[~][commit-marker] use complemented positions within each
*Reservoir*[~][reservoir] namespace; see the *object-key patterns*[~][object-keys].
*Viewpoints*[~][viewpoint] increase from zero; their
*encoded keys*[~][lexidecimal] decrease lexicographically.

`PUT /api/v0/epilogue` accepts multipart `details` (*JSON0*[~][json0]) and
`blob` (raw bytes). `details` contains `viewpoint: bigint` and
`sha384: Uint8Array`, optional `context: Record<string, string>` (default `{}`),
and a required `edges` array (`[]` for an empty graph), using the
*reservation API's*[~][heap-protocol] authenticated child descriptors. Unknown
`details` fields, and a `context` or `edges` of the wrong JSON type, are malformed.
Accept request bodies up to 8 MiB.
Store *context*[~][context] entries as `x-amz-meta-ctx-${key}` object metadata.
Verify each referenced *node*[~][node] before accepting its edge. Require the expected
*viewpoint*[~][viewpoint] and matching *digest*[~][sha384] before accepting a
commit. Rejection must not advance the sequence. Check in this order: request
structure (400), then content (*context*[~][context], edges, and *digest*[~][sha384];
422) before queuing, and the *viewpoint*[~][viewpoint] (409) last, when the
request is prepared, against the prefix that includes earlier prepared batches.
Reply only once that prefix is durable. Rejected requests never enter a
*DifferentialEvent*[~][differential-event]; a batch with none accepted publishes
nothing, and its 409s still wait for every earlier batch.

Responses use *JSON0*[~][json0] with bigint *viewpoints*[~][viewpoint].
All `/api/v0` responses include `timelines.basin.milestone`, a bigint identifying
their known durable *basin*[~][basin] *Milestone*[~][milestone] (zero before the first
*DifferentialEvent*[~][differential-event]).
Successful commits report their published batch; status reports its materialized
prefix, including when cached. A lower value than a client has already observed
reveals a *causal reverse*[~][causal-consistency] across server instances.
A successful commit returns HTTP 201 with its committed *Viewpoint*[~][viewpoint]:

```json
{"viewpoint":"0x0","timelines":{"basin":{"milestone":"0x1"}}}
```

Other failures return `{"error": code, "message": text, "timelines": …}`: 400
for a malformed request or multipart body, 422 for content that fails
validation (such as `digest_mismatch` or a `sha384` of the wrong length, or
invalid *context*[~][context] or edges), 503 `stopped` when the server stops
before the request's batch is durable, including after a failed publication or
lost race (the outcome may be unknown), and 500 when a transaction fails to prepare. An invalid *Flow*[~][flow] id is a malformed request (400)
on every endpoint. Clients act on the status; `error` codes beyond those named
in these pages are informative and may change. Status and reservation requests
return 200.
A *viewpoint*[~][viewpoint] mismatch returns HTTP 409:

```json
{"next":{"viewpoint":"0x1"},"timelines":{"basin":{"milestone":"0x2"}}}
```

`GET /api/v0/epilogue/status` reports the latest committed
*CommitMarker*[~][commit-marker]:

```json
{"latest":{"viewpoint":"0x1","length":10,"url":"<presigned GET>","headers":{"If-Match":"*","Range":"bytes=128-137"}},"timelines":{"basin":{"milestone":"0x2"}}}
```

For `latest`, send the returned `headers` with its URL, including the signed
*conditional read*[~][conditional-read] header. A
*Range GET*[~][range-get] must be cryptographically restricted to the expected
*marker*[~][commit-marker] bytes. When the matching stored
*marker*[~][commit-marker] supplies the URL, its signed Range starts at byte eight
and selects only the raw *EnvBuf message*[~][envbuf]. For zero length,
omit `url` and `headers` and use empty bytes without fetching.

With no committed *marker*[~][commit-marker], `latest` is `null`. A missing or
invalid `flow` returns 400.
