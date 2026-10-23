[conditional-write]: <glossary/conditional-write.md>
[go-faster-fs]: <https://github.com/go-faster/fs>
[sha384]: <glossary/sha384.md>
[versitygw]: <https://github.com/versity/versitygw>
[viewpoint]: <glossary/viewpoint.md>

# Development

Use *go-faster/fs*[^][go-faster-fs] or *Versity Gateway*[^][versitygw] as the
S3-compatible endpoint. Write TypeScript clients that stress one or more
concurrent Rust server processes.

Verify gapless sequences, winning blob contents, and restart recovery. Wrong
*viewpoints*[^][viewpoint] and *digests*[^][sha384] must fail without advancing
state. Race servers against the same position: only the first
*conditional writer*[^][conditional-write] wins.
