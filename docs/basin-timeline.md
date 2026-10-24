[basin]: <glossary/basin.md>
[conditional-write]: <glossary/conditional-write.md>
[differential-event]: <glossary/differential-event.md>
[diffuse16]: <glossary/diffuse16.md>
[epilogue-protocol]: <epilogue-protocol.md>
[flexbuffers]: <glossary/flexbuffers.md>
[flow]: <glossary/flow.md>
[milestone]: <glossary/milestone.md>
[sha384]: <glossary/sha384.md>
[timeline]: <glossary/timeline.md>
[viewpoint]: <glossary/viewpoint.md>

# Basin Timeline

The *Basin*[^][basin]'s shared *Timeline*[^][timeline] records state changes at
`timeline/Diffuse16(milestone)`. *Milestones*[^][milestone] start at one and increase
without gaps. *Diffuse16*[^][diffuse16] key order does not reveal the latest:
list a seed *Milestone*[^][milestone], then search exponentially upward from it.
An empty *Timeline*[^][timeline] expects *Milestone*[^][milestone] one.

Commitflow tuples begin with `Symbol.species`, using the
*FlexBuffers*[^][flexbuffers] extension encoding, and carry a `markers` map
keyed by *Flow*[^][flow] id.
Each entry contains decimal `viewpoint`, hexadecimal *SHA-384*[^][sha384] in
`sha384`, and binary `blob`. *Conditional creation*[^][conditional-write] of a
*DifferentialEvent*[^][differential-event] at the next *Milestone*[^][milestone]
arbitrates competing writers.

`PUT /api/v0/epilogue` adds a `flow` string to the
*commit metadata*[^][epilogue-protocol] and validates against that
*Flow*[^][flow]'s expected *Viewpoint*[^][viewpoint].
`GET /api/v0/epilogue/status?flow=<id>` returns the *common status response*[^][epilogue-protocol].
The `flow` query parameter is an ordinary URL-encoded string.
Mismatches use the *common response*[^][epilogue-protocol].
