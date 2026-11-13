[commit-marker]: <commit-marker.md>
[flow]: <flow.md>
[lexidecimal]: <lexidecimal.md>
[milestone]: <milestone.md>
[node]: <node.md>
[node-promotion]: <node-promotion.md>
[promotion-sign]: <promotion-sign.md>
[upstream]: <upstream.md>
[viewpoint]: <viewpoint.md>

# Marking task

A durably queued depth-first traversal of a *Flow*[^][flow] *Viewpoint's*[^][viewpoint]
*CommitMarker*[^][commit-marker] graph. Stored in `marking_tasks`, keyed by
`(flow, viewpoint)` and indexed by `prioritized`. Its `upstream` column records the
committing *upstream*[^][upstream] *Milestone*[^][milestone] in *Lexidecimal*[^][lexidecimal]. Mark each *node*[^][node]
only after its children. Queue every committed graph, including an empty one;
remove the task only after the entire graph has completed *promotion*[^][node-promotion]
and its *PromotionSign*[^][promotion-sign], with matching *upstream*[^][upstream] metadata,
is confirmed in S3.
