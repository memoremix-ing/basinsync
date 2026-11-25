[basin]: <glossary/basin.md>
[basin-backup]: <basin-backup.md>
[causal-consistency]: <glossary/causal-consistency.md>
[commit-marker]: <glossary/commit-marker.md>
[conditional-read]: <glossary/conditional-read.md>
[conditional-write]: <glossary/conditional-write.md>
[context]: <glossary/context.md>
[differential-event]: <glossary/differential-event.md>
[diy/0zg2/261023-turso-reservoir-vfs]: <diy/0zg2/261023-turso-reservoir-vfs/README.md>
[empty-sentinel]: <glossary/empty-sentinel.md>
[envbuf]: <glossary/envbuf.md>
[epilogue-protocol]: <epilogue-protocol.md>
[flexbuffers]: <glossary/flexbuffers.md>
[flow]: <glossary/flow.md>
[lexidecimal]: <glossary/lexidecimal.md>
[margin]: <glossary/margin.md>
[message-schemas]: <message-schemas.md>
[milestone]: <glossary/milestone.md>
[node]: <glossary/node.md>
[object-keys]: <object-keys.md>
[range-manifest]: <glossary/range-manifest.md>
[sha384]: <glossary/sha384.md>
[timeline]: <glossary/timeline.md>
[tombstone]: <glossary/tombstone.md>
[turso-state]: <turso-state.md>
[viewpoint]: <glossary/viewpoint.md>

# Basin Timeline

The *Basin's*[~][basin] shared *Timeline*[~][timeline] records state changes using the
*Timeline object-key pattern*[~][object-keys]. *Milestones*[~][milestone] start at one and increase
without gaps; *Milestone*[~][milestone] zero has no *Timeline*[~][timeline] key. To catch up, including after
a positive write or status probe, first discover the latest *Basin*[~][basin] *recovery anchor*[~][basin-backup]
and ingest every subsequent *DifferentialEvent*[~][differential-event]. Its
recorded *Milestone*[~][milestone] seeds exponential search for the tail.
Encode complemented *Milestones*[~][milestone] as *Lexidecimal*[~][lexidecimal],
so newer entries sort first. Without a *CommitMarker*[~][commit-marker], LIST the
lowest published key, skipping zero-byte *sentinels*[~][empty-sentinel], and
replay from the beginning through that *Milestone*[~][milestone].
Treat trailing *empty sentinels*[~][empty-sentinel] as exclusive upper search
bounds. A nonempty object under the *Timeline*[~][timeline] prefix whose key is not a
canonical complemented *Milestone*[~][milestone] is corruption; refuse to start. Leading *tombstones*[~][tombstone] occupy retired positions, not replayable
entries; recovery needs a snapshot covering them. An empty *Timeline*[~][timeline] expects *Milestone*[~][milestone] one.
Use *conditional reads*[~][conditional-read] for GETs and HEADs, including search probes.
A probe or catch-up read that fails, rather than finding the position absent,
stops the server like a lost race.

Commitflow tuples begin with `Symbol.species`, using the
*FlexBuffers*[~][flexbuffers] extension encoding, and carry a `markers` map
keyed by *Flow*[~][flow] id.
Each entry contains decimal `viewpoint`, hexadecimal *SHA-384*[~][sha384] in
`sha384`, binary `blob`, *context*[~][context] as `Record<string, string>`, and required `edges` (`[]` for an empty graph) containing derived child *node*[~][node] ids.
Write one commitflow tuple per accepted commit, with a single-entry `markers`
map; readers accept any grouping that keeps each *Flow's*[~][flow]
*Viewpoints*[~][viewpoint] in order. *Conditional creation*[~][conditional-write] of a
*DifferentialEvent*[~][differential-event] at the next *Milestone*[~][milestone]
arbitrates competing writers. Concatenate zero or more *EnvBuf-wrapped*[~][envbuf]
commitflow or `sts/0/databasin/commitkernel` tuples, one `sts/0/databasin/ingestturso` tuple, then a
*range manifest*[~][range-manifest]. Wrap that command feed in one nested
*EnvBuf*[~][envbuf] (`100`), then append a separate *counter margin*[~][margin]. Each tuple is its own
*FlexBuffers*[~][flexbuffers] document. The ingestion command's
*state deltas*[~][turso-state] carry the Turso changes
that materialize the recorded state; all requests wait for durable publication.

`commitkernel` carries the server-driven *Basin backup graph*[~][basin-backup]
as a *CommitMarker*[~][commit-marker] does: `blob` is that backup's root message,
byte for byte as its *Basin*[~][basin] *marker*[~][commit-marker] wraps it, and
`sha384` is its hexadecimal *SHA-384*[~][sha384]. Digest and compare those bytes;
never re-encode a decoded root, since *FlexBuffers*[~][flexbuffers] allows more
than one layout of the same map. Reservations use only ingestion frames.

```cddl
commitkernel-command = command<"sts/0/databasin/commitkernel", {
  viewpoint: decimal, sha384: hex384, blob: bstr,  ; blob: a basin-root message
}>
```

Shared definitions such as `command` and `decimal` are in the *message schemas*[~][message-schemas].

At most two batches sit between preparation and durable publication. A batch
closes at `BASINSYNC_BATCH_MAX` requests, 8 MiB of request data, or the
`BASINSYNC_BATCH_WAIT_MS` window, and its requests share one
*DifferentialEvent*[~][differential-event]; admission holds at most two more full
batches. *Turso Reservoir VFS*[~][diy/0zg2/261023-turso-reservoir-vfs] gives the defaults.
Regardless of in-flight limits, durable publication must follow
*Milestone*[~][milestone] order to preserve *causal consistency*[~][causal-consistency].
Complete one *conditional PUT*[~][conditional-write] before starting the next;
acknowledge a batch only after it and all predecessors are durable.
Predecessor *digests*[~][sha384] cover the complete event *EnvBuf*[~][envbuf],
including its header, message, alignment padding, and footer. Separate trailing
retry *margins*[~][margin] are outside that identity.

`PUT /api/v0/epilogue` adds a `flow` string to the
*commit details*[~][epilogue-protocol] and validates against that
*Flow's*[~][flow] expected *Viewpoint*[~][viewpoint].
`GET /api/v0/epilogue/status?flow=<id>` returns the *common status response*[~][epilogue-protocol].
The `flow` query parameter is an ordinary URL-encoded string.
Mismatches use the *common response*[~][epilogue-protocol].

`BASINSYNC_STATUS_PROBE_MAX_AGE_MS` defaults to 3000; zero probes on every status
request. Reuse a successful probe or refresh across *Flows*[~][flow] within that
window, without extending it on cache hits. Status still waits for pending local
uploads: it waits until every batch prepared before it is durable. Servers
ingest other writers' events only from a drained pipeline. Writes always probe
independently of this allowance: before
preparing from a drained pipeline, probe the next *Milestone*[~][milestone] and catch up
only when it exists. Batches prepared behind an unpublished one need no probe;
the conditional PUT is the race guard. A server that loses
a *conditional write*[~][conditional-write] race fails its unpublished batches and
every queued request, including 409s and status requests still awaiting their
prefix, with 503 `stopped`, answers them, then exits unsuccessfully; batches already durable keep
their success; restarting recovers it from
the *Timeline*[~][timeline]. A drained server probes first, so it loses only
races that begin between that probe and its PUT.
