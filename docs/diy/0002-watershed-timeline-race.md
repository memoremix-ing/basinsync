[commit-marker]: <../glossary/commit-marker.md>
[development]: <../development.md>
[differential-event]: <../glossary/differential-event.md>
[diffuse16]: <../glossary/diffuse16.md>
[downstream]: <../glossary/downstream.md>
[envbuf]: <../glossary/envbuf.md>
[epilogue]: <../glossary/epilogue.md>
[epilogue-protocol]: <../epilogue-protocol.md>
[flexbuffers]: <../glossary/flexbuffers.md>
[flow]: <../glossary/flow.md>
[lexidecimal]: <../glossary/lexidecimal.md>
[milestone]: <../glossary/milestone.md>
[range-get]: <../glossary/range-get.md>
[range-manifest]: <../glossary/range-manifest.md>
[sha384]: <../glossary/sha384.md>
[timeline]: <../glossary/timeline.md>
[upstream]: <../glossary/upstream.md>
[viewpoint]: <../glossary/viewpoint.md>
[watershed]: <../glossary/watershed.md>
[watershed-timeline]: <../watershed-timeline.md>

# 0002 — Watershed Timeline race

Give the *Watershed*[^][watershed] a shared *Timeline*[^][timeline] for changes across
*Flows*[^][flow], replacing *Epilogue*[^][epilogue] listings for state recovery
and refresh.

1. Number *Milestones*[^][milestone] from one; name objects with *Diffuse16*[^][diffuse16].
   List a seed, then search exponentially upward to find the latest.
2. Replay every *DifferentialEvent*[^][differential-event] to recover the mapping
   from *Flow*[^][flow] id to latest *Viewpoint*[^][viewpoint].
3. Add `flow` to the multipart `details` field. Race to conditionally append the
   next *DifferentialEvent*[^][differential-event], then update that *Flow*[^][flow].
   Return an error and terminate after append failure.
4. Refresh from subsequent *Timeline*[^][timeline] entries. In
   `GET /api/v0/epilogue/status?flow=<id>`, `latest` identifies the committed
   *marker*[^][commit-marker] and provides its *GET capability*[^][epilogue-protocol].
   Include `timelines.watershed.milestone` in API responses so clients can detect an
   older materialized prefix when switching servers.
   When the *probe freshness window*[^][watershed-timeline] expires, probe the next
   *Milestone*[^][milestone] before refreshing; absence confirms the materialized
   state is current.

Start each *DifferentialEvent*[^][differential-event] with one
*EnvBuf-wrapped*[^][envbuf] *FlexBuffers*[^][flexbuffers]
*commitflow tuple*[^][watershed-timeline]:

```ts
[Symbol.species, "sync.memoremix.com", "sts/0/databasin/commitflow", {
  markers: { [flow: string]: {
    viewpoint: string; sha384: string; blob: Uint8Array
  } }
}]
```

Use format `101` and eight-byte alignment. Compose append-only chunks, locating
each *marker's*[^][commit-marker] raw `blob` bytes in its finalized chunk.
Append a final *range manifest*[^][range-manifest] indexing preceding
*envelopes*[^][envbuf]; locate the manifest through its final footer.
Later appended commands must preserve earlier blob offsets.

Track each *Flow*[^][flow] and *downstream*[^][downstream]
*Viewpoint's*[^][viewpoint] *upstream*[^][upstream] *Milestone*[^][milestone],
absolute blob offset, content length, and hexadecimal *SHA-384*[^][sha384].
Encode both positions as positive *Lexidecimal*[^][lexidecimal] text for indexing;
derive object keys from *Milestones*[^][milestone] using *Diffuse16*[^][diffuse16].

Return `latest`'s length and a signed *Range GET*[^][range-get] for its bytes in
the *Watershed*[^][watershed] *Timeline*[^][timeline]. Every successful GET must expose
only that *marker*[^][commit-marker]; reject omitted or changed Range headers.
For length zero, omit the URL and headers and use empty bytes without fetching.

Use the *command and route contract*[^][watershed-timeline] and
*development checks*[^][development]. A separate thread will later copy
*CommitMarkers*[^][commit-marker] from the *Timeline*[^][timeline] into
*Flow*[^][flow] *Epilogues*[^][epilogue] and create recovery snapshots.

Test multiple *Flows*[^][flow], concurrent servers, exact blob contents, restart
replay, forward/backward framing, padding and width boundaries, manifests, and
blob slices. Fetch signed ranges and reject omitted, expanded, or changed
headers, including when other sensitive payloads share the object.
