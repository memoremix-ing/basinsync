[commit-marker]: <commit-marker.md>

# Range GET

A GET selecting an inclusive HTTP byte interval (`Range: bytes=start-end`).
Bind that header into a presigned URL's signature to restrict access to the
expected *CommitMarker*[^][commit-marker] bytes. The caller must send the signed
header; omitting or changing it must not expose other bytes in the object.
