[commit-marker]: <glossary/commit-marker.md>
[viewpoint]: <glossary/viewpoint.md>
[lexidecimal]: <glossary/lexidecimal.md>
[sha384]: <glossary/sha384.md>
[conditional-write]: <glossary/conditional-write.md>
[leader]: <glossary/leader.md>
[epilogue]: <glossary/epilogue.md>

# Epilogue protocol

Store each *CommitMarker*[^][commit-marker] at
`epilogue/Lexidecimal(~viewpoint)`. *Viewpoints*[^][viewpoint] increase from zero;
their *encoded keys*[^][lexidecimal] decrease lexicographically.

On startup, list the *Epilogue*[^][epilogue] prefix to obtain its lowest key. Decode its
*viewpoint*[^][viewpoint] and expect its successor. An empty prefix expects zero.

`PUT /epilogue` accepts multipart fields `blob`, `sha384`, and `viewpoint`:
opaque bytes, their *hexadecimal SHA-384*[^][sha384], and a decimal string.
Require the expected *viewpoint*[^][viewpoint] and matching *digest*[^][sha384] before attempting a
*conditional write*[^][conditional-write]. On success, increment the expected
*viewpoint*[^][viewpoint] and respond successfully. On write failure, respond with an error and
terminate: this process is not the *leader*[^][leader].

A *viewpoint*[^][viewpoint] mismatch returns HTTP 409:

```json
{"next":{"viewpoint":"1"},"latest":{"url":"<presigned GET>"}}
```

Use `latest: null` when no *marker*[^][commit-marker] exists. A mismatch or invalid *digest*[^][sha384] must not
advance the sequence.

`GET /epilogue/latest` returns the latest *viewpoint*[^][viewpoint] the server believes committed,
as a decimal string, with a presigned URL to retrieve that *marker*[^][commit-marker]:

```json
{"viewpoint":"0","url":"<presigned GET>"}
```
