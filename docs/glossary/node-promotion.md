[conditional-read]: <conditional-read.md>
[conditional-write]: <conditional-write.md>
[etag]: <etag.md>
[node]: <node.md>
[old-generation]: <old-generation.md>
[revision]: <revision.md>
[s3-copy]: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html>
[young-generation]: <young-generation.md>

# Node promotion

Moving a marked *node's*[^][node] immutable *revision*[^][revision] from the
*young*[^][young-generation] to the *old*[^][old-generation] generation.
Strongly prefer *S3 COPY*[^][s3-copy] so payload bytes stay within object storage;
use *multipart COPY*[^][s3-copy] for larger objects. GET+PUT is an explicitly enabled
compatibility fallback, rather than a response to transient COPY failures.

Promote children before their parent. Verify an existing destination by *conditional HEAD*[^][conditional-read], or
*conditionally create*[^][conditional-write] it from the young object.
Verify its length and original *ETag*[^][etag] before deleting young; record
`promoted` afterward. Preserve the original *ETag*[^][etag] in object metadata
when transfer changes the destination's *ETag*[^][etag].
The `(promoted, marked)` index queues work with `promoted = '' AND marked > ''`;
interrupted work resumes from these durable columns.
