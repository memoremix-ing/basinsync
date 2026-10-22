[epilogue]: <../glossary/epilogue.md>
[epilogue-protocol]: <../epilogue-protocol.md>
[development]: <../development.md>
[viewpoint]: <../glossary/viewpoint.md>
[sha384]: <../glossary/sha384.md>
[conditional-write]: <../glossary/conditional-write.md>
[commit-marker]: <../glossary/commit-marker.md>

# 0001 — Shallow epilogue commits

Start with an *Epilogue*[^][epilogue] of opaque blobs.

1. Build a Rust server that recovers its next *viewpoint*[^][viewpoint] from the bucket's
   lowest *Epilogue*[^][epilogue] key, starting at zero when empty.
2. Accept multipart commits: blob, hexadecimal *SHA-384*[^][sha384], decimal *viewpoint*[^][viewpoint].
   Reject a wrong *viewpoint*[^][viewpoint] or *digest*[^][sha384]; otherwise *conditionally create*[^][conditional-write] its *marker*[^][commit-marker].
   Advance after success; return an error and terminate after write failure.
3. Offer the latest *viewpoint*[^][viewpoint] and its presigned *marker*[^][commit-marker] URL. On *viewpoint*[^][viewpoint] mismatch,
   return the expected next *viewpoint*[^][viewpoint] and the latest *marker*[^][commit-marker]'s URL.
4. Stress concurrent writers with TypeScript clients against local S3.

Use the *wire protocol*[^][epilogue-protocol] and
*development checks*[^][development]; leave richer *markers*[^][commit-marker] and graceful race
recovery for later milestones.
