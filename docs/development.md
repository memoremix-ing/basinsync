[conditional-write]: <glossary/conditional-write.md>
[observability]: <observability.md>
[sha384]: <glossary/sha384.md>
[versitygw]: <https://github.com/versity/versitygw/releases/tag/v1.11.0>
[viewpoint]: <glossary/viewpoint.md>

# Development

Configure the server through its environment: `S3_ENDPOINT`, `S3_BUCKET`,
`AWS_REGION` (default `us-east-1`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and optional `AWS_SESSION_TOKEN`, using path-style bucket addressing; and
`BASINSYNC_LISTEN` for the HTTP address (default `127.0.0.1:3000`). Tutorials
introduce further `BASINSYNC_*` tuning variables.

Use *VersityGW v1.11.0*[~][versitygw] as the S3-compatible test endpoint, with its
POSIX backend and a separate metadata sidecar directory. Install the pinned binary:

```sh
mkdir -p .local/bin
CGO_ENABLED=0 GOBIN="$PWD/.local/bin" go install github.com/versity/versitygw/cmd/versitygw@v1.11.0
```

Test fixtures launch isolated instances; `VERSITYGW_BIN` overrides the executable.
Its POSIX backend lists an in-progress PUT as a temporary `.<name>.sgwtmp.<n>`
object beside its key; ignore those when listing while uploads may be running.
The integration suite verifies atomic destination preconditions and source ETags
for COPY before exercising concurrent Rust server processes with TypeScript clients.

Verify gapless sequences, winning blob contents, and restart recovery. Wrong
*viewpoints*[~][viewpoint] and *digests*[~][sha384] must fail without advancing
state. Race servers against the same position: only the first
*conditional writer*[~][conditional-write] wins.

Queued mutations belong to workers, not HTTP handlers: a lost reply must not
cancel publication. Trace cancellation through callers before adding timeouts
or `select!`, especially around temporarily removed state or remote writes;
cancellation does not roll back S3.

Shutdown closes admission and drains queued publications and already-started
background work. It starts no final backup or promotion pass by default.
`BASINSYNC_BACKUP_ON_SHUTDOWN=true` opts into a final backup and promotion pass,
including when `BASINSYNC_BACKUP_INTERVAL_MS=0` disables periodic backups.
Keep the internal request handler available until active producers finish their
durable updates. `BASINSYNC_SHUTDOWN_TIMEOUT_MS` defaults to `30000`; exhausting
it exits unsuccessfully and leaves in-flight outcomes for recovery. Test these
boundaries with gated I/O, disconnects, source failures, and shutdown signals.

Inspect request/batch correlation and scrape process-local metrics through the
*observability interface*[~][observability].
