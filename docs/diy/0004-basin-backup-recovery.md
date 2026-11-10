[0001-shallow-epilogue-commits]: <0001-shallow-epilogue-commits.md>
[0003-turso-basin-vfs]: <0003-turso-basin-vfs.md>
[0004-backup-overhead]: <../benchmarks/0004-backup-overhead.md>
[basin]: <../glossary/basin.md>
[basin-backup]: <../basin-backup.md>
[commit-marker]: <../glossary/commit-marker.md>
[conditional-write]: <../glossary/conditional-write.md>
[development]: <../development.md>
[differential-event]: <../glossary/differential-event.md>
[epilogue]: <../glossary/epilogue.md>
[epilogue-compaction]: <../glossary/epilogue-compaction.md>
[flow]: <../glossary/flow.md>
[jet]: <../glossary/jet.md>
[milestone]: <../glossary/milestone.md>
[prologue]: <../glossary/prologue.md>
[prologue-vacuuming]: <../glossary/prologue-vacuuming.md>
[range-get]: <../glossary/range-get.md>
[reservoir]: <../glossary/reservoir.md>
[sha384]: <../glossary/sha384.md>
[timeline]: <../glossary/timeline.md>
[timeline-eviction]: <../glossary/timeline-eviction.md>
[viewpoint]: <../glossary/viewpoint.md>
[virtual-file-system]: <../glossary/virtual-file-system.md>

# 0004 — Basin backup and recovery

*Basins*[^][basin] and *Flows*[^][flow] are *Reservoirs*[^][reservoir], each with
an *Epilogue*[^][epilogue], *Timeline (Chronologue)*[^][timeline], and
*Prologue*[^][prologue]. Give the *Basin*[^][basin] its own
*Epilogue*[^][epilogue]. Revisit *Prologues*[^][prologue] and the third
*Reservoir*[^][reservoir] type, the *Jet*[^][jet], later.

Promote *0003*[^][0003-turso-basin-vfs]'s file-backed copy-on-write
*VFS*[^][virtual-file-system] into the server. Pin a consistent, checkpointed
*Milestone*[^][milestone] through backup publication while request preparation
continues. Use the entire `default.turso` database file as the
*Basin*[^][basin] *CommitMarker*[^][commit-marker]; follow the
*key and metadata contract*[^][basin-backup].

A separate worker first copies every *Flow*[^][flow] *CommitMarker*[^][commit-marker]
through that durable *Milestone*[^][milestone] into its
*Epilogue*[^][epilogue], as in *0001*[^][0001-shallow-epilogue-commits]. Only then
publish the pinned backup at the next *Basin*[^][basin]
*Viewpoint*[^][viewpoint] using a *conditional PUT*[^][conditional-write].
Keep one active backup and coalesce pending targets. Bound independent
*Flow*[^][flow] copies to eight concurrent workers, preserving each
*Flow*[^][flow] sequence and completing each *Milestone*[^][milestone] before
copying the next. Client success still waits only for durable *Timeline*[^][timeline]
publication. For status `latest`, HEAD its known *Flow*[^][flow]
*Epilogue*[^][epilogue] key and verify length and *digest*[^][sha384] before using its
whole-object URL; otherwise retain the *Timeline*[^][timeline]
*Range GET*[^][range-get]. Test URL selection and copied contents directly.

Before writing the *Timeline*[^][timeline], read the latest
*Basin*[^][basin] *Viewpoint*[^][viewpoint] and corresponding
*Milestone*[^][milestone]. Load its snapshot when needed and successfully ingest
all subsequent *DifferentialEvents*[^][differential-event]. Use that
*Milestone*[^][milestone] as the exponential-search seed. With no backup, recover
from the beginning. Preserve ordered publication across the two-batch pipeline.
For status, probe the next *Milestone*[^][milestone] first; only discover a newer
*Basin*[^][basin] backup and refresh when that successor exists.

Test pinned-image equality against full frame replay, snapshot-plus-suffix
recovery, delayed and multipart uploads, concurrent backup workers, interrupted copies, lost
replies, and corrupt backups. Run the *development checks*[^][development] and
compare *background backup overhead*[^][0004-backup-overhead].

`BASINSYNC_DATA_DIR` defaults to `.local/state`; each writer uses its own
reconstructed on-disk cache. `BASINSYNC_BACKUP_INTERVAL_MS` defaults to 1000;
zero disables background backups for comparisons. Export with bounded buffers
and stream uploads. *Epilogue compaction*[^][epilogue-compaction],
*Timeline eviction*[^][timeline-eviction], and
*Prologue vacuuming*[^][prologue-vacuuming] remain for later tutorials.
