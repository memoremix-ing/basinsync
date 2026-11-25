[reservoir-vfs]: <../docs/diy/0zg2/261023-turso-reservoir-vfs/README.md>
[turso]: <../docs/glossary/turso.md>
[turso-state]: <../docs/turso-state.md>

# Turso materialization

The documentation pins *Turso*[~][turso] and its configuration in the
*delta reference*[~][turso-state]. This repository vendors that revision as the
`vendor/turso` submodule; clean rooms get a read-only copy of the same source.
`turso_core` 0.9.0-pre.6 on crates.io breaks five of the APIs used here.

The *Turso Reservoir VFS*[~][reservoir-vfs] tutorial describes how this
repository captures logical and physical frames and pins snapshots.
