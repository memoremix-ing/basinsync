[flow]: <flow.md>
[node]: <node.md>
[timeline]: <timeline.md>

# Revision

A random UUIDv4 identifying one allocation of a *node*[^][node]. Append it to the
node id in each generation's object key. Reusing a reclaimed node id creates a
new revision, keeping stale deletion requests and acknowledgments scoped to the
previous allocation without revealing its *Flow*[^][flow] or *Timeline*[^][timeline] position.
