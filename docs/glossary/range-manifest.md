[byte-coordinate]: <byte-coordinate.md>
[differential-event]: <differential-event.md>
[envbuf]: <envbuf.md>
[flexbuffers]: <flexbuffers.md>
[lexidecimal]: <lexidecimal.md>
[margin]: <margin.md>
[message-schemas]: <../message-schemas.md>

# Range manifest

The final *non-margin*[~][margin] *EnvBuf*[~][envbuf] in a command feed. Its
*FlexBuffers*[~][flexbuffers] message indexes preceding command *envelopes*[~][envbuf] and *margin runs*[~][margin] by their
exclusive end offset relative to the command feed's start, encoded as positive
*Lexidecimal*[~][lexidecimal]:

```cddl
rangemanifest-command = command<"sts/0/databasin/rangemanifest", {
  coordinate: big, envelopes: range-envelopes,
}>
range-envelopes = { * tstr => (command-prefix / null) }  ; keys: positive Lexidecimal
```

Shared definitions such as `command` and `decimal` are in the *message schemas*[~][message-schemas].

Command values are prefixes without query payloads. A consecutive run of *margin
envelopes*[~][margin] has one `null` entry at the last envelope's exclusive end.
The manifest omits itself. Containing S3 objects carry
`x-amz-meta-manifest-range: bytes=start-end`, its complete *EnvBuf's*[~][envbuf]
inclusive decimal byte range, excluding trailing *margins*[~][margin]. Fetch that range directly,
or scan backward over separate storage *margins*[~][margin] to find the event's
outer footer. Its last inner *envelope*[~][envbuf] is the manifest.

*FlexBuffers*[~][flexbuffers] sorts these keys lexicographically, so neighboring
decoded offsets bound one command *EnvBuf*[~][envbuf] or *margin run*[~][margin]: `[previous, current)`, with
zero preceding the first key. With command-feed origin `base`, its HTTP Range
is `bytes=(base + previous)-(base + current - 1)`. For a standalone
*DifferentialEvent*[~][differential-event], `base` is eight; concatenating events
adds each outer envelope's starting offset.

For a *DifferentialEvent*[~][differential-event], `coordinate` is its starting
*Timeline byte coordinate*[~][byte-coordinate], covered by its existing predecessor
digest chain. S3 metadata repeats it as `x-amz-meta-coordinate` in canonical decimal.
