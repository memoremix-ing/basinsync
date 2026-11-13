[commit-marker]: <commit-marker.md>
[epilogue]: <epilogue.md>
[epilogue-compaction]: <epilogue-compaction.md>
[lexidecimal]: <lexidecimal.md>
[milestone]: <milestone.md>
[node-promotion]: <node-promotion.md>
[upstream]: <upstream.md>
[viewpoint]: <viewpoint.md>

# PromotionSign

The S3 complement of a *CommitMarker*[^][commit-marker], stored in the same
*Epilogue*[^][epilogue] using its uncomplemented *Lexidecimal*[^][lexidecimal]
*Viewpoint*[^][viewpoint]: `epilogue/lex(viewpoint)`, versus `epilogue/lex(~viewpoint)`.
Its presence certifies that the entire graph has completed *promotion*[^][node-promotion],
including an empty graph. Its `x-amz-meta-upstream` records the source
*upstream*[^][upstream] *Milestone*[^][milestone] as canonical decimal.
*Epilogue compaction*[^][epilogue-compaction] is expected to use a contiguous available prefix
of stored *marker*[^][commit-marker]/sign pairs. Compaction should DELETE signs while
*markers*[^][commit-marker] are tombstoned. LISTers validate corresponding
*markers*[^][commit-marker], deleting and skipping stale signs on demand to locate
the oldest available snapshot.
