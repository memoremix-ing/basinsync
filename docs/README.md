[0001-shallow-epilogue-commits]: <diy/0001-shallow-epilogue-commits.md>
[0002-watershed-timeline-race]: <diy/0002-watershed-timeline-race.md>
[0003-turso-reservoir-vfs]: <diy/0003-turso-reservoir-vfs.md>
[0004-watershed-backup-recovery]: <diy/0004-watershed-backup-recovery.md>
[0005-shallow-heap-management]: <diy/0005-shallow-heap-management.md>
[0006-async-shallow-cleanup]: <diy/0006-async-shallow-cleanup.md>
[0007-deep-heap-support]: <diy/0007-deep-heap-support.md>
[0008-commit-marker-edges-with-node-promotion]: <diy/0008-commit-marker-edges-with-node-promotion.md>

# basinsync

A Rust server for assembling, retiring, and garbage collecting immutable,
first-writer-wins directed acyclic graphs of data nodes backed by S3-compatible
object storage.

Build it incrementally, recording milestones as concise tutorials with linked
reference and glossary entries. Begin with
*0001 — Shallow epilogue commits*[^][0001-shallow-epilogue-commits].

Coordinate writes and locate payloads with
*0002 — Watershed Timeline race*[^][0002-watershed-timeline-race].

Then materialize *0003 — Turso Reservoir VFS*[^][0003-turso-reservoir-vfs].

Recover from snapshots with *0004 — Watershed backup and recovery*[^][0004-watershed-backup-recovery].

Stage uploads with *0005 — Shallow heap management*[^][0005-shallow-heap-management].


Reclaim staged objects with *0006 — Async shallow cleanup*[^][0006-async-shallow-cleanup].

Build deeper graphs with *0007 — Deep heap support*[^][0007-deep-heap-support].

Retain and promote committed graphs with
*0008 — CommitMarker edges with node promotion*[^][0008-commit-marker-edges-with-node-promotion].
