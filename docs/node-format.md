[access-token]: <glossary/access-token.md>
[envbuf]: <glossary/envbuf.md>
[flexbuffers]: <glossary/flexbuffers.md>
[flow]: <glossary/flow.md>
[hkdf]: <https://www.rfc-editor.org/rfc/rfc5869>
[node]: <glossary/node.md>
[node-height]: <glossary/node-height.md>
[object-keys]: <object-keys.md>
[revision]: <glossary/revision.md>
[strong-edge]: <glossary/strong-edge.md>
[weak-link]: <glossary/weak-link.md>

# Basin node format 0

Store *basin nodes*[~][node] as numeric-keyed *FlexBuffers maps*[~][flexbuffers]
inside format-`101` *EnvBufs*[~][envbuf]. *Basin edges*[~][strong-edge] are
seven-element `Symbol.match` vectors. Structural schema, consumer migration,
and *node-id*[~][node] version are independent. Readers reject unsupported tags;
consumer migrations rebuild through the old reader and the new consumer.

`breadth` sums direct degree and child breadth; like `weight`, it may count shared
nested contributions repeatedly. *Height*[~][node-height] starts at one for an
edge-free structured node and is one greater than the highest
*strong-edge*[~][strong-edge] target; inline structure adds no height.
Writes supply distinct outgoing *strong edges*[~][strong-edge]
to storage; *weak links*[~][weak-link] do not retain targets. Both carry the
node allocation's UUIDv4 *revision*[~][revision]. Storage returns that revision
before the parent is encoded; readers derive the shared-heap *object key*[~][object-keys]
from the token, height, version, and revision. No *Flow*[~][flow] revision is needed for
these shared objects. Tenant storage configuration and signing stay outside the graph.

A client secret of at least 32 bytes derives 32-byte entropy using
`HMAC-SHA384(seed, UTF8("basinsync/basin-node/entropy/0") || SHA384(node_bytes))`.
*HKDF-SHA384*[~][hkdf] uses this entropy, a zero salt, and info
`basinsync/basin-node/0/{token,secret,nonce}`, yielding 32/32/12 bytes.
An *access token*[~][access-token] is derived when requesting storage actions.

