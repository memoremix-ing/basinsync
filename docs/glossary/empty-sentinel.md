[conditional-write]: <conditional-write.md>
[etag]: <etag.md>
[margin]: <margin.md>
[object-keys]: <../object-keys.md>
[tombstone]: <tombstone.md>

# Empty sentinel

A zero-byte sequence object carrying only metadata. A trailing sentinel is an
exclusive upper search bound, not a published entry. Servers never create
trailing sentinels; operators or other tools may place them at absent
positions, and servers must tolerate them anywhere past the published tail. Retired leading positions
use immutable *tombstones*[~][tombstone] instead. Bootstrap the bucket's *reference object*[~][object-keys]
with `If-None-Match: *`, verify zero length, and retain its observed *ETag*[~][etag].
Do not hardcode a provider's empty-object validator.

Create absent entries *conditionally*[~][conditional-write]; replace a sentinel
only with `If-Match: <observed ETag>`. Nonempty entries remain first-writer-wins.
Metadata-only rewrites may retain the same *ETag*[~][etag], so this does not fence
competing metadata revisions.

Require every successful sequence write to return an *ETag*[~][etag] distinct
from the empty reference before acknowledging publication. A match fails the
postcondition: increment the feed's trailing *counter margin*[~][margin] and retry with
`If-Match` on that observed validator.

Identify sentinels by zero length, never by *ETag*[~][etag] alone. A nonempty
object whose *ETag*[~][etag] matches the empty reference is a publication in
progress: competing writers lose to it, recovery counts it as published, and
only its own writer rewrites it, to change the trailing margin. Probe *standalone margins*[~][margin]
conditionally at startup. Opaque user blobs outside sequences may still be empty.
