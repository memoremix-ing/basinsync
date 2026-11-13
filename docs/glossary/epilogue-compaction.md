[commit-marker]: <commit-marker.md>
[epilogue]: <epilogue.md>
[promotion-sign]: <promotion-sign.md>
[viewpoint]: <viewpoint.md>

# Epilogue compaction

Reclaim *CommitMarker*[^][commit-marker] payloads in an *Epilogue*[^][epilogue]
up to, but not through, a retained *Viewpoint*[^][viewpoint].

Plan for a contiguous available prefix of stored *CommitMarker*[^][commit-marker]/
*PromotionSign*[^][promotion-sign] pairs. Tombstone compacted *markers*[^][commit-marker]
with zero-length objects and explicit metadata, such as `x-amz-meta-compacted-at`;
empty payloads alone are valid *markers*[^][commit-marker]. Then DELETE their signs.

Sign publishers check for tombstones before and after PUT, removing their sign
if compaction overtook publication. LISTers validate the corresponding
*markers*[^][commit-marker], deleting and skipping signs for tombstones on demand
before selecting the oldest available snapshot.
