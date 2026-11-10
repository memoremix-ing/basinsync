[causal-consistency]: <glossary/causal-consistency.md>
[commit-marker]: <glossary/commit-marker.md>
[conditional-read]: <glossary/conditional-read.md>
[conditional-write]: <glossary/conditional-write.md>
[differential-event]: <glossary/differential-event.md>
[diffuse16]: <glossary/diffuse16.md>
[envbuf]: <glossary/envbuf.md>
[epilogue-protocol]: <epilogue-protocol.md>
[flexbuffers]: <glossary/flexbuffers.md>
[flow]: <glossary/flow.md>
[milestone]: <glossary/milestone.md>
[physical-frame]: <glossary/physical-frame.md>
[range-manifest]: <glossary/range-manifest.md>
[sha384]: <glossary/sha384.md>
[timeline]: <glossary/timeline.md>
[turso-state]: <turso-state.md>
[viewpoint]: <glossary/viewpoint.md>
[watershed]: <glossary/watershed.md>
[watershed-backup]: <watershed-backup.md>

# Watershed Timeline

The *Watershed*[^][watershed]'s shared *Timeline*[^][timeline] records state changes at
`timeline/Diffuse16(milestone)`. *Milestones*[^][milestone] start at one and increase
without gaps. Before writing, read the latest *Watershed*[^][watershed] *recovery anchor*[^][watershed-backup]
and ingest every subsequent *DifferentialEvent*[^][differential-event]. Its
recorded *Milestone*[^][milestone] seeds exponential search for the tail.
Without a *CommitMarker*[^][commit-marker], list a seed in the
*Timeline*[^][timeline] keyspace and replay from the beginning.
*Diffuse16*[^][diffuse16] key order does not reveal the latest.
An empty *Timeline*[^][timeline] expects *Milestone*[^][milestone] one.
Use *conditional reads*[^][conditional-read] for GETs and HEADs, including search probes.

Commitflow tuples begin with `Symbol.species`, using the
*FlexBuffers*[^][flexbuffers] extension encoding, and carry a `markers` map
keyed by *Flow*[^][flow] id.
Each entry contains decimal `viewpoint`, hexadecimal *SHA-384*[^][sha384] in
`sha384`, and binary `blob`. *Conditional creation*[^][conditional-write] of a
*DifferentialEvent*[^][differential-event] at the next *Milestone*[^][milestone]
arbitrates competing writers. Concatenate *EnvBuf*[^][envbuf]-wrapped
commitflow tuples, one `sts/0/databasin/ingestturso` tuple, then a
*range manifest*[^][range-manifest]. Each tuple is its own
*FlexBuffers*[^][flexbuffers] document. The ingestion command's
*Turso deltas*[^][turso-state] carry the *physical frames*[^][physical-frame]
that materialize the recorded state; all requests wait for durable publication.

Regardless of in-flight limits, durable publication must follow
*Milestone*[^][milestone] order to preserve *causal consistency*[^][causal-consistency].
Complete one *conditional PUT*[^][conditional-write] before starting the next;
acknowledge a batch only after it and all predecessors are durable.

`PUT /api/v0/epilogue` adds a `flow` string to the
*commit details*[^][epilogue-protocol] and validates against that
*Flow*[^][flow]'s expected *Viewpoint*[^][viewpoint].
`GET /api/v0/epilogue/status?flow=<id>` returns the *common status response*[^][epilogue-protocol].
The `flow` query parameter is an ordinary URL-encoded string.
Mismatches use the *common response*[^][epilogue-protocol].

`BASINSYNC_STATUS_PROBE_MAX_AGE_MS` defaults to 3000; zero probes on every status
request. Reuse a successful probe or refresh across *Flows*[^][flow] within that
window, without extending it on cache hits. Status still waits for pending local
uploads; writes always refresh independently of this allowance.
