# Conditional write

S3 `PutObject` with `If-None-Match: *` creates an object only when its key is
absent. Competing writers cannot replace the first writer's bytes.
