[commit-marker]: <../glossary/commit-marker.md>
[conditional-read]: <../glossary/conditional-read.md>
[conditional-write]: <../glossary/conditional-write.md>
[development]: <../development.md>
[epilogue]: <../glossary/epilogue.md>
[epilogue-protocol]: <../epilogue-protocol.md>
[json0]: <../glossary/json0.md>
[sha384]: <../glossary/sha384.md>
[viewpoint]: <../glossary/viewpoint.md>

# 0001 — Shallow epilogue commits

Start with an *Epilogue*[^][epilogue] of opaque blobs.

1. Build a Rust server that recovers its next *viewpoint*[^][viewpoint] from the
   bucket's lowest *Epilogue*[^][epilogue] key, starting at zero when empty.
2. Accept `PUT /api/v0/epilogue`: a raw `blob` part and *JSON0*[^][json0]
   `details` containing a bigint *viewpoint*[^][viewpoint] and byte-array
   *SHA-384*[^][sha384]. Reject a wrong *viewpoint*[^][viewpoint] or
   *digest*[^][sha384]; otherwise *conditionally create*[^][conditional-write]
   its *marker*[^][commit-marker]. Advance after success; return an error and
   terminate after write failure.
3. Offer `GET /api/v0/epilogue/status`. Return `latest` with the committed
   *marker's*[^][commit-marker] *viewpoint*[^][viewpoint], length, and presigned
   GET URL with *conditional read headers*[^][conditional-read]. For length zero,
   omit the URL and headers;
   when empty, return `latest: null`.
   On *viewpoint*[^][viewpoint] mismatch, return the expected next
   *viewpoint*[^][viewpoint].
4. Stress concurrent writers with TypeScript clients against local S3.
   Check decreasing, gapless keys and winning blob contents, then restart to
   verify recovery.

Use the *wire protocol*[^][epilogue-protocol] and
*development checks*[^][development]; leave richer *markers*[^][commit-marker]
and graceful race recovery for later milestones.
