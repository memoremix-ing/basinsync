[node]: <node.md>
[revision]: <revision.md>

# ETag

An opaque validator returned by object storage, cached in `graph_nodes.etag` after verifying
object presence and content length. Identical uploads may share an ETag;
*revisions*[^][revision] distinguish allocations of the same *node*[^][node] id.
