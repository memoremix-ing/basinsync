[access-token]: <../glossary/access-token.md>
[commit-marker]: <../glossary/commit-marker.md>
[conditional-read]: <../glossary/conditional-read.md>
[development]: <../development.md>
[etag]: <../glossary/etag.md>
[heap-protocol]: <../heap-protocol.md>
[node]: <../glossary/node.md>
[node-degree]: <../glossary/node-degree.md>
[node-height]: <../glossary/node-height.md>
[old-generation]: <../glossary/old-generation.md>
[retainer]: <../glossary/retainer.md>
[revision]: <../glossary/revision.md>
[timeline]: <../glossary/timeline.md>
[young-generation]: <../glossary/young-generation.md>

# 0007 — Deep heap support

Lift the *reservation API's*[^][heap-protocol] *zero-height*[^][node-height] and
empty-edge restrictions. Each edge supplies `{ auth: [height, version, token] }`;
derive the child's *node*[^][node] id without persisting its *access token*[^][access-token].
Require parent *height*[^][node-height] greater than every child *height*[^][node-height]. Version remains zero;
existing *height*[^][node-height] and token-size limits apply. Make `BASINSYNC_NODE_MAX_DEGREE`
configurable (128), counting distinct children; edge order and duplicates do not change the child set.

For an existing parent, require identical content length and child-id set,
including when other *nodes*[^][node] already retain it. For a new parent,
require every child to have a live `graph_nodes` allocation. Use its cached *etag*[^][etag];
otherwise perform a *conditional HEAD*[^][conditional-read] on its
*young-generation*[^][young-generation] key, trying the *old generation*[^][old-generation]
if absent. Verify content length and a nonempty *ETag*[^][etag]; report per-parent errors
when presence cannot be verified.

Run HEADs outside the serialized writer. Recheck each child's live *revision*[^][revision]
in the transaction that caches *etags*[^][etag], inserts the parent, adds its staging
*retainer*[^][retainer], and records `(node: child_id, retainer: parent_id)` edges.

Extend sweeping: a freed parent first releases its outgoing edges in bounded
transactions, marking children freed when their last *retainer*[^][retainer] disappears.
Use the existing `(retainer, node)` index and indexed freed queue for recursive work.
Match the parent's *revision*[^][revision] in every batch. Only after all outbound edges are durably
gone may its exact *young-generation*[^][young-generation] object be deleted;
remove `graph_nodes` only after confirmed deletion and no remaining edges in either direction.
Persist changes through *Timeline*[^][timeline] ingestion frames.

Test shared descendants, immutable child sets, height and *degree*[^][node-degree]
limits, cached *etags*[^][etag], both generations, missing/unverifiable children, slow HEADs,
verification/reclamation races, bounded recursive sweeps, id reuse, and logical/physical
replay through snapshot recovery. Run the *development checks*[^][development].

Defer *CommitMarker*[^][commit-marker] edges and *old-generation*[^][old-generation] deletion to later tutorials.
