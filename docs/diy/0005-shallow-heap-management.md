[access-token]: <../glossary/access-token.md>
[commit-marker]: <../glossary/commit-marker.md>
[dag]: <../glossary/dag.md>
[development]: <../development.md>
[flow]: <../glossary/flow.md>
[heap-protocol]: <../heap-protocol.md>
[heap-reservation]: <../glossary/heap-reservation.md>
[node]: <../glossary/node.md>
[node-height]: <../glossary/node-height.md>
[old-generation]: <../glossary/old-generation.md>
[retainer]: <../glossary/retainer.md>
[timeline]: <../glossary/timeline.md>
[turso]: <../glossary/turso.md>
[viewpoint]: <../glossary/viewpoint.md>
[watershed]: <../glossary/watershed.md>
[young-generation]: <../glossary/young-generation.md>

# 0005 — Shallow heap management

Prepare for *Viewpoints*[^][viewpoint] rooted at a *CommitMarker*[^][commit-marker]
with a *DAG*[^][dag] of opaque *nodes*[^][node]. Introduce *heap reservations*[^][heap-reservation]
so clients can upload before publication, while the *Watershed*[^][watershed]
counts incoming edges for eventual collection.

Implement the *staging endpoint*[^][heap-protocol]. Require the *Flow's*[^][flow]
singular expected next *Viewpoint*[^][viewpoint]. Accept only *height*[^][node-height]
zero, version zero, and empty edge lists. Configure `BASINSYNC_HEAP_MAX_HEIGHT`
(128) and `BASINSYNC_HEAP_MAX_TOKEN_BYTES` (64).

Expand `default.turso`:

```sql
CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  content_length INTEGER NOT NULL CHECK(content_length >= 0),
  reserved DATETIME NOT NULL,
  etag TEXT NOT NULL,
  promoted DATETIME NOT NULL
);
CREATE TABLE graph_edges (
  node TEXT NOT NULL,
  retainer TEXT NOT NULL,
  PRIMARY KEY (node, retainer),
  CHECK (retainer < node)
);
CREATE INDEX graph_edges_retainer ON graph_edges(retainer);
```

For each valid *node*[^][node], insert its id, length, current reservation time,
and empty etag/promotion values, then its staging *retainer*[^][retainer] edge.
On collision, require matching length and no incoming `n-` edges; add the
staging edge idempotently. Report errors by input index while retaining valid
entries in the same transaction.

Derive ids before queuing work. Never persist *access tokens*[^][access-token],
including in logs or the *Timeline*[^][timeline]. Journal the
*reservation command*[^][heap-protocol], followed by the existing *Turso*[^][turso]
frame-ingestion command. Return actions only after durable, ordered publication;
recover through captured frames.

Test indexed errors, collisions, duplicate retainers, signed lengths and headers,
first-writer uploads, zero lengths, races, pipeline failures, snapshot recovery,
and token non-persistence. Run the *development checks*[^][development].

Defer erasing *young-generation*[^][young-generation] *nodes*[^][node] not transitively
retained by the *CommitMarker*[^][commit-marker],
*CommitMarker*[^][commit-marker] edges with uploaded-target checks, promotion to
the *old generation*[^][old-generation], references to promoted *nodes*[^][node],
and higher *nodes*[^][node] with targets in either generation.
