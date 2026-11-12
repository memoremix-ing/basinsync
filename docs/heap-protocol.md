[conditional-read]: <glossary/conditional-read.md>
[conditional-write]: <glossary/conditional-write.md>
[epilogue-protocol]: <epilogue-protocol.md>
[flow]: <glossary/flow.md>
[heap-reservation]: <glossary/heap-reservation.md>
[json0]: <glossary/json0.md>
[node]: <glossary/node.md>
[old-generation]: <glossary/old-generation.md>
[revision]: <glossary/revision.md>
[viewpoint]: <glossary/viewpoint.md>
[young-generation]: <glossary/young-generation.md>

# Heap staging protocol

`POST /api/v0/heap/reserve` accepts *JSON0*[^][json0] for the
*Flow's*[^][flow] expected next *Viewpoint*[^][viewpoint]:

```ts
{
  flow: string;
  viewpoint: bigint;
  nodes: Array<{
    auth: [height: number, version: number, token: Uint8Array];
    length: number;
    edges: [];
  }>;
}
```

A wrong *Viewpoint*[^][viewpoint] returns the *common 409 response*[^][epilogue-protocol].
Otherwise return HTTP 200 with nullable maps indexed by input position:

```ts
type Action = { url: string; headers: Record<string, string> };
{
  errors: Record<number, { code: string; message: string }> | null;
  results: Record<number, { actions: {
    write: Action | null; preview: Action | null; read: Action;
  } }> | null;
  timelines: { watershed: { milestone: bigint } };
}
```

Successful *reservations*[^][heap-reservation] are durable before returning.
`write` is a *conditional PUT*[^][conditional-write] to the
*young generation*[^][young-generation], signing `If-None-Match: *` and the
specified `Content-Length`. `preview` and `read` are
*conditional GETs*[^][conditional-read] for that *node*[^][node] in the
*young*[^][young-generation] and *old*[^][old-generation] generations respectively.
Both object keys end in `${node_id}/${revision}`, sharing the stored UUIDv4
*revision*[^][revision]. Send each action's headers. A nonempty stored etag makes `write` null; a valid
promotion timestamp makes `preview` null.

