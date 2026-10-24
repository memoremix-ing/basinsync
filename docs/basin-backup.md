[basin]: <glossary/basin.md>
[commit-marker]: <glossary/commit-marker.md>
[conditional-write]: <glossary/conditional-write.md>
[epilogue]: <glossary/epilogue.md>
[epilogue-compaction]: <glossary/epilogue-compaction.md>
[flow]: <glossary/flow.md>
[lexidecimal]: <glossary/lexidecimal.md>
[milestone]: <glossary/milestone.md>
[prologue-vacuuming]: <glossary/prologue-vacuuming.md>
[reservoir]: <glossary/reservoir.md>
[sha384]: <glossary/sha384.md>
[timeline]: <glossary/timeline.md>
[timeline-eviction]: <glossary/timeline-eviction.md>
[turso]: <glossary/turso.md>
[viewpoint]: <glossary/viewpoint.md>

# Basin backup and recovery

Keep *Reservoir*[^][reservoir] keyspaces separate. Within one bucket:

```text
epilogue/Lexidecimal(~viewpoint)                       # Basin
flows/0x<lowercase UTF-8 hex of id>/epilogue/Lexidecimal(~viewpoint)
```

Use *complemented Lexidecimal*[^][lexidecimal] positions for both
*Epilogues*[^][epilogue]. *Basin*[^][basin] *Viewpoints*[^][viewpoint] count
backups independently of *Milestones*[^][milestone]. A backup's S3 metadata
binds its image to the recovery prefix:

```text
x-amz-meta-milestone: <canonical decimal>
x-amz-meta-event-sha384: <digest of DifferentialEvent at that Milestone>
x-amz-meta-sha384: <digest of CommitMarker bytes>
x-amz-meta-turso-version: <engine release and revision>
```

Digests are hexadecimal *SHA-384*[^][sha384]. Validate metadata, checksum,
*Turso*[^][turso] version, and the image's recorded *Milestone*[^][milestone].

Before publishing a *Basin*[^][basin] *CommitMarker*[^][commit-marker], replicate
all *Flow*[^][flow] *markers*[^][commit-marker] through its
*Milestone*[^][milestone] into their *Epilogues*[^][epilogue]. Use
*conditional creation*[^][conditional-write]; verify existing bytes on retry.
Competing backup workers adopt the winning *Viewpoint*[^][viewpoint], keeping
backed-up *Milestones*[^][milestone] increasing.

A stored *CommitMarker*[^][commit-marker] permits, but does not require,
*Epilogue compaction*[^][epilogue-compaction] before its
*Viewpoint*[^][viewpoint] and *Timeline eviction*[^][timeline-eviction] through
its *Milestone*[^][milestone]. Serialize cleanup requests through the
*Basin*[^][basin] *Timeline*[^][timeline]. Replacing payloads with zero-length
objects can preserve *conditional-write barriers*[^][conditional-write]. *Prologue vacuuming*[^][prologue-vacuuming]
is a separate process.
