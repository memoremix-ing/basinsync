---
prerequisites:
  - 0zg0/261022-shallow-epilogue-commits
---

[basin]: <../../../glossary/basin.md>
[basin-timeline]: <../../../basin-timeline.md>
[byte-coordinate]: <../../../glossary/byte-coordinate.md>
[commit-marker]: <../../../glossary/commit-marker.md>
[context]: <../../../glossary/context.md>
[crc32c]: <../../../glossary/crc32c.md>
[development]: <../../../development.md>
[differential-event]: <../../../glossary/differential-event.md>
[downstream]: <../../../glossary/downstream.md>
[empty-sentinel]: <../../../glossary/empty-sentinel.md>
[envbuf]: <../../../glossary/envbuf.md>
[epilogue]: <../../../glossary/epilogue.md>
[epilogue-protocol]: <../../../epilogue-protocol.md>
[flexbuffers]: <../../../glossary/flexbuffers.md>
[flow]: <../../../glossary/flow.md>
[lexidecimal]: <../../../glossary/lexidecimal.md>
[margin]: <../../../glossary/margin.md>
[message-schemas]: <../../../message-schemas.md>
[milestone]: <../../../glossary/milestone.md>
[range-get]: <../../../glossary/range-get.md>
[range-manifest]: <../../../glossary/range-manifest.md>
[sha384]: <../../../glossary/sha384.md>
[timeline]: <../../../glossary/timeline.md>
[upstream]: <../../../glossary/upstream.md>
[viewpoint]: <../../../glossary/viewpoint.md>

# Basin Timeline race

Give the *Basin*[~][basin] a shared *Timeline*[~][timeline] for changes across
*Flows*[~][flow], replacing *Epilogue*[~][epilogue] listings for state recovery
and refresh.

1. Number *Milestones*[~][milestone] from one; name objects with complemented
   *Lexidecimal*[~][lexidecimal]. LIST the lowest published key to find the latest,
   skipping zero-byte *sentinels*[~][empty-sentinel].
2. Replay every *DifferentialEvent*[~][differential-event] to recover the mapping
   from *Flow*[~][flow] id to latest *Viewpoint*[~][viewpoint].
3. Add `flow` to the multipart `details` field. Race to conditionally append the
   next *DifferentialEvent*[~][differential-event], then update that *Flow*[~][flow].
   Return an error and terminate after append failure.
4. Refresh from subsequent *Timeline*[~][timeline] entries. In
   `GET /api/v0/epilogue/status?flow=<id>`, `latest` identifies the committed
   *marker*[~][commit-marker] and provides its *GET capability*[~][epilogue-protocol].
   Include `timelines.basin.milestone` in API responses so clients can detect an
   older materialized prefix when switching servers.
   When the *probe freshness window*[~][basin-timeline] expires, probe the next
   *Milestone*[~][milestone] before refreshing; absence confirms the materialized
   state is current.

Wrap each *DifferentialEvent's*[~][differential-event] command feed in one nested
*EnvBuf*[~][envbuf] (`100`) so complete events can concatenate. Start its message with one
*EnvBuf-wrapped*[~][envbuf] *FlexBuffers*[~][flexbuffers]
*commitflow tuple*[~][basin-timeline]:

```cddl
commitflow-command = command<"sts/0/databasin/commitflow", {
  markers: { * tstr => commit-marker }
}>
commit-marker = {
  viewpoint: decimal, sha384: hex384, blob: bstr,
  context: { * tstr => tstr }, edges: [* tstr],
}
```

Shared definitions such as `command` and `decimal` are in the *message schemas*[~][message-schemas].

Preserve *context*[~][context] for later *CommitMarker*[~][commit-marker] replication.

Use format `101` for commands and pad each complete envelope to a multiple of eight bytes
to preserve stable, *FlexBuffers-friendly*[~][flexbuffers] alignment.
Compose append-only chunks, locating
each *marker's*[~][commit-marker] raw `blob` bytes in its finalized chunk.
Append a final *range manifest*[~][range-manifest] indexing preceding
*envelopes*[~][envbuf] with offsets relative to the inner command feed.
Reserve the outer header before assembling chunks; translate blob offsets to the
containing object. Set `x-amz-meta-manifest-range: bytes=start-end` on the S3
object to the complete manifest *envelope's*[~][envbuf] inclusive decimal byte range,
excluding the default trailing *counter margin*[~][margin], so clients can fetch it directly.
Finalize the outer header and footer, then append that margin as a separate envelope.
Later appended commands must preserve earlier blob offsets.
A *Timeline*[~][timeline] predecessor's *SHA-384*[~][sha384] covers the complete
event *EnvBuf*[~][envbuf], including header, message, padding, and footer; separate
trailing *margins*[~][margin] are excluded. A retry can
therefore update its trailing *margin*[~][margin] without changing already-prepared successor bindings.

Track each *Flow*[~][flow] and *downstream*[~][downstream]
*Viewpoint's*[~][viewpoint] *upstream*[~][upstream] *Milestone*[~][milestone],
absolute blob offset, content length, and hexadecimal *SHA-384*[~][sha384].
Encode both positions as positive *Lexidecimal*[~][lexidecimal] text for indexing;
complement *Milestones*[~][milestone] before encoding their object keys.

Return `latest`'s length and a signed *Range GET*[~][range-get] for its bytes in
the *Basin*[~][basin] *Timeline*[~][timeline]. Every successful GET must expose
only that *marker*[~][commit-marker]; reject omitted or changed Range headers.
For length zero, omit the URL and headers and use empty bytes without fetching.

Use the *command and route contract*[~][basin-timeline] and
*development checks*[~][development]. A separate thread will later copy
*CommitMarkers*[~][commit-marker] from the *Timeline*[~][timeline] into
*Flow*[~][flow] *Epilogues*[~][epilogue] and create recovery snapshots.

Test multiple *Flows*[~][flow], concurrent servers, exact blob contents, restart
replay, forward/backward framing, *margins*[~][margin], padding and width boundaries, manifests, and
blob slices. Fetch signed ranges and reject omitted, expanded, or changed
headers, including when other sensitive payloads share the object.

Maintain cumulative *CRC32C*[~][crc32c] over the margin-free *coordinate run*[~][byte-coordinate].
Publish its starting and ending values in each *DifferentialEvent's*[~][differential-event]
S3 metadata.
