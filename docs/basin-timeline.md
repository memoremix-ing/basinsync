[basin]: <glossary/basin.md>
[conditional-write]: <glossary/conditional-write.md>
[differential-event]: <glossary/differential-event.md>
[diffuse16]: <glossary/diffuse16.md>
[epilogue-protocol]: <epilogue-protocol.md>
[flow]: <glossary/flow.md>
[moment]: <glossary/moment.md>
[sha384]: <glossary/sha384.md>
[timeline]: <glossary/timeline.md>
[viewpoint]: <glossary/viewpoint.md>

# Basin Timeline

The *Basin*[^][basin]'s shared *Timeline*[^][timeline] records state changes at
`timeline/Diffuse16(moment)`. *Moments*[^][moment] start at one and increase
without gaps. *Diffuse16*[^][diffuse16] key order does not reveal the latest:
list a seed *Moment*[^][moment], then search exponentially upward from it.
An empty *Timeline*[^][timeline] expects *Moment*[^][moment] one.

Commitflow commands carry a `markers` map keyed by *Flow*[^][flow] id.
Each entry contains decimal `viewpoint`, hexadecimal *SHA-384*[^][sha384] in
`sha384`, and binary `blob`. *Conditional creation*[^][conditional-write] of a
*DifferentialEvent*[^][differential-event] at the next *Moment*[^][moment]
arbitrates competing writers.

`PUT /api/v0/epilogue` accepts a `flow` string alongside the
*common commit fields*[^][epilogue-protocol] and validates against that
*Flow*[^][flow]'s expected *Viewpoint*[^][viewpoint].
`GET /api/v0/epilogue/status?flow=<id>` returns the *common status response*[^][epilogue-protocol].
Mismatches use the *common response*[^][epilogue-protocol].
