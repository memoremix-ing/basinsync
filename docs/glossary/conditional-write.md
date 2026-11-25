[commit-marker]: <commit-marker.md>
[empty-sentinel]: <empty-sentinel.md>
[epilogue-compaction]: <epilogue-compaction.md>
[etag]: <etag.md>
[tombstone]: <tombstone.md>

# Conditional write

S3 `PutObject` with `If-None-Match: *` creates an object only when its key is
absent. A zero-byte *sentinel*[~][empty-sentinel] can instead be replaced using
its observed *ETag*[~][etag] in `If-Match`: try `If-None-Match: *` first, and on
412 read the key; if it holds the empty sentinel, retry with `If-Match` on that
validator, otherwise another writer won. If that `If-Match` also fails, another
writer won. Competing writers cannot replace a
nonempty first writer's bytes, including *tombstones*[~][tombstone]. The one
exception is *Epilogue compaction*[~][epilogue-compaction], which replaces a
retired *CommitMarker*[~][commit-marker] with a *tombstone*[~][tombstone] using
`If-Match` on the marker's observed *ETag*[~][etag]. A successful
sequence write must also satisfy its *ETag postcondition*[~][empty-sentinel].
