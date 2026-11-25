[basin]: <glossary/basin.md>
[commit-marker]: <glossary/commit-marker.md>
[conditional-write]: <glossary/conditional-write.md>
[context]: <glossary/context.md>
[crc32c]: <glossary/crc32c.md>
[envbuf]: <glossary/envbuf.md>
[epilogue]: <glossary/epilogue.md>
[epilogue-compaction]: <glossary/epilogue-compaction.md>
[flexbuffers]: <glossary/flexbuffers.md>
[flow]: <glossary/flow.md>
[kernelspace]: <glossary/kernelspace.md>
[lexidecimal]: <glossary/lexidecimal.md>
[marking-task]: <glossary/marking-task.md>
[message-schemas]: <message-schemas.md>
[milestone]: <glossary/milestone.md>
[node]: <glossary/node.md>
[node-promotion]: <glossary/node-promotion.md>
[object-keys]: <object-keys.md>
[prologue-vacuuming]: <glossary/prologue-vacuuming.md>
[promotion-sign]: <glossary/promotion-sign.md>
[reservoir]: <glossary/reservoir.md>
[sha384]: <glossary/sha384.md>
[timeline]: <glossary/timeline.md>
[timeline-eviction]: <glossary/timeline-eviction.md>
[tombstone]: <glossary/tombstone.md>
[viewpoint]: <glossary/viewpoint.md>

# Basin backup and recovery

Keep *Reservoir*[~][reservoir] keyspaces separate using the shared
*object-key patterns*[~][object-keys].

Use *complemented Lexidecimal*[~][lexidecimal] positions for *markers*[~][commit-marker]
in both *Epilogues*[~][epilogue]; their *PromotionSigns*[~][promotion-sign] use
uncomplemented positions in those same namespaces. *Basin*[~][basin]
*Viewpoints*[~][viewpoint] count backups independently of *Milestones*[~][milestone].
A *Basin*[~][basin] root is a *FlexBuffers*[~][flexbuffers] message:

```cddl
basin-root = {
  version: tstr,           ; Turso release and revision
  milestone: decimal,      ; covered Milestone M
  coordinate: decimal,     ; exclusive coordinate
  crc32c: hex-crc32c,      ; cumulative CRC32C
  parent: hex384,          ; event SHA-384 at M
  databases: { "default.turso": backup-node, "kernel.turso": backup-node },
}
backup-node = { id: tstr, revision: tstr, length: uint, sha384: hex384 }
```

Shared definitions such as `command` and `decimal` are in the *message schemas*[~][message-schemas].

Both database images are height-zero *KernelSpace*[~][kernelspace] *nodes*[~][node]
at the same prefix. Verify their lengths, checksums, and recorded
*Milestones*[~][milestone] before exposing either. Restore both, then replay
from `M + 1`; the *marker's*[~][commit-marker] own reservation and commit events
follow `M`. Fetch immutable revisions from either generation using the
*object-key patterns*[~][object-keys].
A backup's S3 metadata
binds its image to the recovery prefix:

```text
x-amz-meta-milestone: <canonical decimal>
x-amz-meta-coordinate: <exclusive Timeline byte coordinate, canonical decimal>
x-amz-meta-crc32c: <cumulative coordinate-run CRC32C, eight lowercase hex digits>
x-amz-meta-event-sha384: <digest of DifferentialEvent at that Milestone>
x-amz-meta-sha384: <digest of CommitMarker bytes>
x-amz-meta-turso-version: <Turso release and revision>
```

Retain the *CRC32C*[~][crc32c] as the recovered prefix's accumulator.
Other digests are hexadecimal *SHA-384*[~][sha384]. Unwrap the raw *EnvBuf message*[~][envbuf], validate metadata and its checksum,
then validate the root's Turso version and recovery prefix.

Before publishing a *Basin*[~][basin] *CommitMarker*[~][commit-marker], replicate
all *Flow*[~][flow] *markers*[~][commit-marker] through its
*Milestone*[~][milestone] into their *Epilogues*[~][epilogue]. Use
*conditional creation*[~][conditional-write]; preserve *context*[~][context] metadata, add
`x-amz-meta-sha384` with the blob's hexadecimal *SHA-384*[~][sha384], and verify existing bytes and context on retry.
Competing backup workers adopt the winning *Viewpoint*[~][viewpoint], keeping
backed-up *Milestones*[~][milestone] increasing.

Queue *marking tasks*[~][marking-task] with `commitkernel`; retain them through
*promotion*[~][node-promotion] of both database images and S3 confirmation of the
*PromotionSign*[~][promotion-sign]. Preserve image checksums through COPY.
A sign's `upstream` is the committing *Milestone*[~][milestone], which follows
the root's covered prefix `M`.

Plan future *Epilogue compaction*[~][epilogue-compaction] around a contiguous
available prefix of stored *CommitMarker*[~][commit-marker]/*PromotionSign*[~][promotion-sign]
pairs. *Markers*[~][commit-marker] must have reached their *Epilogues*[~][epilogue]
from the *Basin*[~][basin] *Timeline*[~][timeline]; a recovery anchor alone
is insufficient. Compact up to, but not through, the retained *Viewpoint*[~][viewpoint].
Replace compacted *markers*[~][commit-marker] with bucket-proven
*tombstones*[~][tombstone],
retaining their keys and metadata, and DELETE their
*PromotionSigns*[~][promotion-sign]. A sign LISTer checks the corresponding
*marker*[~][commit-marker] metadata, deleting and skipping stale signs on demand
before selecting the oldest available snapshot; see *compaction*[~][epilogue-compaction].

A stored *Basin*[~][basin] recovery anchor permits *Timeline eviction*[~][timeline-eviction]
through its *Milestone*[~][milestone] once the corresponding *Flow*[~][flow]
*markers*[~][commit-marker] are replicated. Serialize cleanup requests through the
*Basin*[~][basin] *Timeline*[~][timeline]. *Prologue vacuuming*[~][prologue-vacuuming]
is a separate process.
