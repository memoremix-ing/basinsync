[commit-marker]: <commit-marker.md>
[heap]: <heap.md>
[heap-reservation]: <heap-reservation.md>
[json0]: <json0.md>
[node]: <node.md>

# Context

A `Record<string, string>` supplied in commit `details` or per *node*[~][node]
in a *Heap reservation*[~][heap-reservation], using *JSON0*[~][json0]
string values. Each entry becomes `x-amz-meta-ctx-${key}` metadata on the stored
*CommitMarker*[~][commit-marker] or uploaded *node*[~][node]; omitted context means an empty map.

Names must be nonempty HTTP header suffixes without NUL and distinct ignoring
case. Values must be printable ASCII; metadata, including service metadata, must fit
S3's 2 KiB user-metadata limit. Validate before accepting the request.

Commits keep context names as supplied in their *CommitMarker*[~][commit-marker].
A *Heap*[~][heap] reservation persists lowercase-key context. Repeated
reservations must match its keys and values, even before upload; omitted context
means `{}`.
