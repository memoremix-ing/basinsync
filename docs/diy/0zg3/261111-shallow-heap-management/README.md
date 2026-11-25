---
prerequisites:
  - 0zg2/261023-turso-reservoir-vfs
---

[access-token]: <../../../glossary/access-token.md>
[basin]: <../../../glossary/basin.md>
[commit-marker]: <../../../glossary/commit-marker.md>
[context]: <../../../glossary/context.md>
[dag]: <../../../glossary/dag.md>
[development]: <../../../development.md>
[flow]: <../../../glossary/flow.md>
[heap-protocol]: <../../../heap-protocol.md>
[heap-reservation]: <../../../glossary/heap-reservation.md>
[jet]: <../../../glossary/jet.md>
[kernelspace]: <../../../glossary/kernelspace.md>
[node]: <../../../glossary/node.md>
[node-height]: <../../../glossary/node-height.md>
[old-generation]: <../../../glossary/old-generation.md>
[retainer]: <../../../glossary/retainer.md>
[timeline]: <../../../glossary/timeline.md>
[turso]: <../../../glossary/turso.md>
[userspace]: <../../../glossary/userspace.md>
[viewpoint]: <../../../glossary/viewpoint.md>
[young-generation]: <../../../glossary/young-generation.md>

# Shallow Heap management

Prepare for *Viewpoints*[~][viewpoint] rooted at a *CommitMarker*[~][commit-marker]
with a *DAG*[~][dag] of opaque *nodes*[~][node]. Introduce *Heap reservations*[~][heap-reservation]
so clients can upload before publication, while the *Basin*[~][basin]
counts incoming edges for eventual collection in *UserSpace*[~][userspace].

Implement the *staging endpoint*[~][heap-protocol]. Require the *Flow's*[~][flow]
singular expected next *Viewpoint*[~][viewpoint]. Accept only *height*[~][node-height]
zero, version zero, and empty edge lists. Configure `BASINSYNC_HEAP_MAX_HEIGHT`
(128) and `BASINSYNC_HEAP_MAX_TOKEN_BYTES` (64); empty tokens are valid.

Each submitted *node*[~][node] may include `context: Record<string, string>`
(default `{}`). Validate its *context*[~][context] and bind `x-amz-meta-ctx-` headers
into its write action; clients must send the returned headers unchanged. Persist
lowercase-key context as JSON text with the reservation. Repeated reservations
require identical context, even before upload; mismatches return an indexed error.

Expand `default.turso`:

```sql
CREATE TABLE userspace_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  content_length INTEGER NOT NULL CHECK(content_length >= 0),
  context TEXT NOT NULL DEFAULT '{}',
  reserved DATETIME NOT NULL,
  etag TEXT NOT NULL,
  promoted DATETIME NOT NULL
);
CREATE TABLE userspace_edges (
  node TEXT NOT NULL,
  retainer TEXT NOT NULL,
  PRIMARY KEY (node, retainer),
  CHECK (retainer < node)
);
CREATE INDEX userspace_edges_retainer ON userspace_edges(retainer, node);
```

For each valid *node*[~][node], insert its id, length, current reservation time,
and empty etag/promotion values (server-written times are UTC RFC 3339 text;
`''` means unset), then its staging *retainer*[~][retainer] edge.
On collision, require matching length and *context*[~][context]; add the
staging edge idempotently. Report errors by input index while retaining valid
entries in the same transaction.

Derive ids before queuing work. Never persist *access tokens*[~][access-token],
including in logs or the *Timeline*[~][timeline]. Persist reservation changes
through the existing *Turso*[~][turso] frame-ingestion command. Return actions
only after durable, ordered publication; recover through captured frames.

Test indexed errors, collisions, duplicate retainers, signed lengths and headers,
*context*[~][context] validation, collisions, recovery, and tampering,
first-writer uploads, zero lengths, races, pipeline failures, snapshot recovery,
and token non-persistence. Run the *development checks*[~][development].

Defer erasing *young-generation*[~][young-generation] *nodes*[~][node] not transitively
retained by the *CommitMarker*[~][commit-marker],
*CommitMarker*[~][commit-marker] edges with uploaded-target checks, promotion to
the *old generation*[~][old-generation], references to promoted *nodes*[~][node],
and higher *nodes*[~][node] with targets in either generation.

*KernelSpace's*[~][kernelspace] `kernelspace_nodes` and `kernelspace_edges` for
server-driven *Basin*[~][basin] and *Jet*[~][jet] graphs come later.
