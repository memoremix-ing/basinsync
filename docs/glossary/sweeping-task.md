[flow]: <flow.md>
[retainer]: <retainer.md>
[viewpoint]: <viewpoint.md>

# Sweeping task

A durably queued request to release a *Flow*[^][flow] *Viewpoint's*[^][viewpoint]
`A_` staging *retainer*[^][retainer] edges. Stored in `sweeping_tasks`, keyed by
`(flow, viewpoint)` and indexed by its `prioritized` timestamp.
