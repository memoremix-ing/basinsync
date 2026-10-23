[commit-marker]: <../glossary/commit-marker.md>
[conditional-write]: <../glossary/conditional-write.md>
[development]: <../development.md>
[epilogue]: <../glossary/epilogue.md>
[epilogue-protocol]: <../epilogue-protocol.md>
[sha384]: <../glossary/sha384.md>
[viewpoint]: <../glossary/viewpoint.md>

# 0001 — Shallow epilogue commits

Start with an *Epilogue*[^][epilogue] of opaque blobs.

1. Build a Rust server that recovers its next *viewpoint*[^][viewpoint] from the
   bucket's lowest *Epilogue*[^][epilogue] key, starting at zero when empty.
2. Accept `PUT /epilogue`: blob, hexadecimal *SHA-384*[^][sha384], decimal
   *viewpoint*[^][viewpoint]. Reject a wrong *viewpoint*[^][viewpoint] or
   *digest*[^][sha384]; otherwise *conditionally create*[^][conditional-write]
   its *marker*[^][commit-marker]. Advance after success; return an error and
   terminate after write failure.
3. Offer `GET /epilogue/status`. Its `latest` and `recent`
   *viewpoints*[^][viewpoint] match; `recent` also contains the committed
   *marker*[^][commit-marker]'s presigned GET URL.
   On *viewpoint*[^][viewpoint] mismatch, return the expected next
   *viewpoint*[^][viewpoint].
4. Stress concurrent writers with TypeScript clients against local S3.
   Check decreasing, gapless keys and winning blob contents, then restart to
   verify recovery.

Use the *wire protocol*[^][epilogue-protocol] and
*development checks*[^][development]; leave richer *markers*[^][commit-marker]
and graceful race recovery for later milestones.
