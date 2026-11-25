[diy/0zg0/261022-shallow-epilogue-commits]: <diy/0zg0/261022-shallow-epilogue-commits/README.md>
[diy/0zg1/261023-basin-timeline-race]: <diy/0zg1/261023-basin-timeline-race/README.md>
[diy/0zg2/261023-turso-reservoir-vfs]: <diy/0zg2/261023-turso-reservoir-vfs/README.md>
[diy/0zg3/261024-basin-backup-recovery]: <diy/0zg3/261024-basin-backup-recovery/README.md>
[diy/0zg3/261111-shallow-heap-management]: <diy/0zg3/261111-shallow-heap-management/README.md>
[diy/0zg4/261112-async-shallow-cleanup]: <diy/0zg4/261112-async-shallow-cleanup/README.md>
[diy/0zg4/261117-timeline-recovery-acceleration]: <diy/0zg4/261117-timeline-recovery-acceleration/README.md>
[diy/0zg5/261112-deep-heap-support]: <diy/0zg5/261112-deep-heap-support/README.md>
[diy/0zg6/261112-commit-marker-edges-with-node-promotion]: <diy/0zg6/261112-commit-marker-edges-with-node-promotion/README.md>
[diy/0zg6/261120-basin-node-stdlib]: <diy/0zg6/261120-basin-node-stdlib/README.md>
[diy/0zg7/261118-shallow-basin-backup-nodes]: <diy/0zg7/261118-shallow-basin-backup-nodes/README.md>
[diy/0zg8/261119-observability]: <diy/0zg8/261119-observability/README.md>
[diy/0zg9/261121-durable-test-suites]: <diy/0zg9/261121-durable-test-suites/README.md>
[lexidecimal]: <glossary/lexidecimal.md>
[object-keys]: <object-keys.md>

# basinsync

A Rust server for assembling, retiring, and garbage collecting immutable,
first-writer-wins directed acyclic graphs of data nodes backed by S3-compatible
object storage.

Build it incrementally, recording milestones as concise tutorials with linked
reference and glossary entries. Height folders encode dependency height in
*Lexidecimal*[~][lexidecimal]; frontmatter lists prerequisite folders relative to `diy/`.
Tutorial folders may nest by repeating height/name pairs; tutorial slugs carry their introduction date as `YYMMDD-`; their topics must be
unique throughout `diy/`. Tutorials at the same height are parallel branches, not a reading sequence. Begin with
*Shallow epilogue commits*[~][diy/0zg0/261022-shallow-epilogue-commits].

Coordinate writes and locate payloads with
*Basin Timeline race*[~][diy/0zg1/261023-basin-timeline-race].

Then materialize *Turso Reservoir VFS*[~][diy/0zg2/261023-turso-reservoir-vfs].

Recover from snapshots with *Basin backup and recovery*[~][diy/0zg3/261024-basin-backup-recovery].

Independently of backup support, stage uploads with *Shallow Heap management*[~][diy/0zg3/261111-shallow-heap-management].

Reclaim staged objects with *Async shallow cleanup*[~][diy/0zg4/261112-async-shallow-cleanup].

Build deeper graphs with *Deep Heap support*[~][diy/0zg5/261112-deep-heap-support].

Retain and promote committed graphs with
*CommitMarker edges with node promotion*[~][diy/0zg6/261112-commit-marker-edges-with-node-promotion].

Build storage-friendly structures with the *Basin node standard library*[~][diy/0zg6/261120-basin-node-stdlib].

Coalesce and retrieve history with *Timeline recovery acceleration*[~][diy/0zg4/261117-timeline-recovery-acceleration].

Back up paired database graphs with
*Shallow Basin backup nodes*[~][diy/0zg7/261118-shallow-basin-backup-nodes].

Inspect request publication and background progress with
*Observability*[~][diy/0zg8/261119-observability].

Keep the test suites small and resilient with
*Durable test suites*[~][diy/0zg9/261121-durable-test-suites].

Audit storage layouts in the *object-key reference*[~][object-keys].
