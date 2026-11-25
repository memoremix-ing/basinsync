[bulk-order]: <bulk-order.md>
[byte-coordinate]: <byte-coordinate.md>
[differential-event]: <differential-event.md>
[envbuf]: <envbuf.md>
[flexbuffers]: <flexbuffers.md>
[margin]: <margin.md>
[message-schemas]: <../message-schemas.md>
[milestone]: <milestone.md>
[object-keys]: <../object-keys.md>

# BulkManifest

A format `101` *EnvBuf*[~][envbuf] indexing complete, trimmed
*DifferentialEvents*[~][differential-event] in a *BulkOrder*[~][bulk-order]:

```cddl
bulkmanifest-command = command<"sts/0/databasin/bulkmanifest", {
  lowest: big, coordinate: big, ends: [+ uint],
}>
```

Shared definitions such as `command` and `decimal` are in the *message schemas*[~][message-schemas].

`lowest` is the first inclusive *Milestone*[~][milestone]; `coordinate` is its
starting *byte coordinate*[~][byte-coordinate]. Each `ends` entry is one
*event's*[~][differential-event] exclusive end relative to the object's beginning.
Starts are implicit: zero for the first event, then the preceding end.
Require positive, strictly increasing eight-byte boundaries; the last end is
the footer's start. Derive the exclusive upper *Milestone*[~][milestone] as
`lowest + BigInt(ends.length)` and each global end by adding `coordinate`.
Trimmed events have no trailing retry *margins*[~][margin], so logical and
physical offsets coincide throughout the event prefix.

For example, `lowest: 42`, `coordinate: 65536`, `ends: [488, 1360, 1976]`
indexes *Milestones*[~][milestone] 42 through 44 (exclusive upper 45), with
global ends 66024, 66896, and 67512.

Encode `lowest` and `coordinate` with the *bigint extension*[~][flexbuffers],
and `ends` as an ordinary signed-integer vector, keeping `VT_VECTOR_UINT`
reserved for extensions. Verify indexed framing, lengths, and coordinates.

The *object key's*[~][object-keys] `/v0/<bulkmanifest-start>/<coordinate>` suffix records the
exclusive event end and starting *coordinate*[~][byte-coordinate], both canonical
decimal. Fetch `bytes=<bulkmanifest-start>-`, parse its first envelope as the footer, and skip
trailing *margins*[~][margin], without HEAD. Footer encoding and length do not
enter the key when trimmed event bytes are identical. S3 metadata
`x-amz-meta-bulkmanifest-range` records the complete footer range;
`x-amz-meta-coordinate` repeats the logical start.

Known event-boundary coordinates translate directly into HTTP Ranges by subtracting
the order's starting coordinate, without first fetching its manifest. Neither
the footer nor the order's own trailing *margin*[~][margin] has logical extent.
