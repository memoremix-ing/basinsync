[basin]: <../glossary/basin.md>
[basin-timeline]: <../basin-timeline.md>
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
[jet]: <../glossary/jet.md>
[lexidecimal]: <../glossary/lexidecimal.md>
[milestone]: <../glossary/milestone.md>
[range-get]: <../glossary/range-get.md>
[range-manifest]: <../glossary/range-manifest.md>
[sha384]: <../glossary/sha384.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[turso-state]: <../turso-state.md>
[upstream]: <../glossary/upstream.md>
[viewpoint]: <../glossary/viewpoint.md>

# 0005 — EnvBuf log formatting

Compose each *DifferentialEvent*[^][differential-event] as concatenated
*EnvBuf*[^][envbuf] chunks, each wrapping one *FlexBuffers*[^][flexbuffers]
command tuple, using format `101` and eight-byte alignment. Append
*commitflow commands*[^][basin-timeline] incrementally, locating each
*marker*[^][commit-marker]'s raw `blob` bytes in its finalized chunk. Record
absolute offsets from the start of the eventual S3 object.

Materialize those locations in the same *Turso*[^][turso] transaction as the
commit. Append its *ingestturso chunk*[^][turso-state], then the *range manifest*[^][range-manifest].
Appending these chunks must preserve all earlier blob offsets. Follow the
*Timeline contract*[^][basin-timeline].

Expand `default.turso`:

```sql
CREATE TABLE marker_ranges (
  flow TEXT NOT NULL,
  downstream TEXT NOT NULL,
  upstream TEXT NOT NULL,
  blob_offset INTEGER NOT NULL CHECK(blob_offset >= 0),
  content_length INTEGER NOT NULL CHECK(content_length >= 0),
  sha384 TEXT NOT NULL,
  PRIMARY KEY (flow, downstream)
);
CREATE INDEX marker_ranges_upstream ON marker_ranges(upstream);
```

Store the *upstream*[^][upstream] *Milestone*[^][milestone] and
*downstream*[^][downstream] *Viewpoint*[^][viewpoint] as positive
*Lexidecimal*[^][lexidecimal] text, and the digest as hexadecimal
*SHA-384*[^][sha384]. Derive S3 *Timeline*[^][timeline] keys from the decoded
*Milestone*[^][milestone] using *Diffuse16*[^][diffuse16]. The terminology also
fits a later *Jet*[^][jet], whose payloads will be
*DifferentialEvents*[^][differential-event] destined for *Flow*[^][flow]
*Timeline*[^][timeline] *Milestones*[^][milestone].

Extend status `latest` with its content length and a
*GET capability*[^][epilogue-protocol]. Use a signed *Range GET*[^][range-get]
against the *Basin*[^][basin] *Timeline*[^][timeline], or reuse `recent`'s URL
once the matching *CommitMarker*[^][commit-marker] is stored in the
*Flow*[^][flow] *Epilogue*[^][epilogue]. Every successful GET must expose only
that *marker*[^][commit-marker]. For length zero, omit the URL; clients already
have the empty bytes.

Test forward/backward framing, padding and width boundaries, manifests, blob
slices, indexed-location recovery, and URL reuse after copying. Fetch signed
ranges and reject omitted, expanded, or changed headers, including when other
sensitive payloads share the object. Run the *development checks*[^][development].
