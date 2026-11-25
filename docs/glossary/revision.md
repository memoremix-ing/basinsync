[flow]: <flow.md>
[node]: <node.md>
[object-keys]: <../object-keys.md>
[timeline]: <timeline.md>

# Revision

A random UUIDv4 identifying one allocation of a *node*[~][node], written in
lowercase hyphenated form; reject other spellings. Append it to the
node id in each generation's object key. Reusing a reclaimed node id creates a
new revision, keeping stale deletion requests and acknowledgments scoped to the
previous allocation without revealing its *Flow*[~][flow] or *Timeline*[~][timeline] position.

A *Flow*[~][flow] also has a revision, assigned in its first commit transaction
and preserved on recovery; see the *object-key patterns*[~][object-keys].
