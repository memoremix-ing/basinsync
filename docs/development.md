[go-faster-fs]: <https://github.com/go-faster/fs>
[versitygw]: <https://github.com/versity/versitygw>
[epilogue-protocol]: <epilogue-protocol.md>
[viewpoint]: <glossary/viewpoint.md>
[sha384]: <glossary/sha384.md>
[commit-marker]: <glossary/commit-marker.md>
[conditional-write]: <glossary/conditional-write.md>

# Development

Use *go-faster/fs*[^][go-faster-fs] or *Versity Gateway*[^][versitygw] as the
S3-compatible endpoint. Implement the *protocol*[^][epilogue-protocol] in Rust
and write TypeScript clients that stress one or more concurrent server processes.

Check that accepted commits form a gapless sequence with decreasing keys and
that stored bytes match the winning blobs. Wrong *viewpoints*[^][viewpoint] and *digests*[^][sha384] must
fail; mismatch URLs must retrieve the latest *marker*[^][commit-marker]. Restarting must recover
the next position. Race servers against the same position: only the first
*conditional writer*[^][conditional-write] wins, losing processes terminate, and the winner can continue.
