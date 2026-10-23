[basin]: <../glossary/basin.md>
[basin-timeline]: <../basin-timeline.md>
[commit-marker]: <../glossary/commit-marker.md>
[development]: <../development.md>
[differential-event]: <../glossary/differential-event.md>
[diffuse16]: <../glossary/diffuse16.md>
[epilogue]: <../glossary/epilogue.md>
[flexbuffers]: <../glossary/flexbuffers.md>
[flow]: <../glossary/flow.md>
[moment]: <../glossary/moment.md>
[timeline]: <../glossary/timeline.md>
[viewpoint]: <../glossary/viewpoint.md>

# 0002 — Basin Timeline race

Give the *Basin*[^][basin] a shared *Timeline*[^][timeline] for changes across
*Flows*[^][flow], replacing *Epilogue*[^][epilogue] listings for state recovery
and refresh.

1. Number *Moments*[^][moment] from one; name objects with *Diffuse16*[^][diffuse16].
   List a seed, then search exponentially upward to find the latest.
2. Replay every *DifferentialEvent*[^][differential-event] to recover the mapping
   from *Flow*[^][flow] id to latest *Viewpoint*[^][viewpoint].
3. Add `flow` to commits. Race to conditionally append the next
   *DifferentialEvent*[^][differential-event], then update that *Flow*[^][flow].
   Return an error and terminate after append failure.
4. Refresh from subsequent *Timeline*[^][timeline] entries. In
   `GET /epilogue/status?flow=<id>`, `latest` reflects committed
   *viewpoints*[^][viewpoint] while `recent` remains `null` until copying is
   implemented. Test multiple
   *Flows*[^][flow], concurrent servers, exact blob contents, and restart replay.

Each *DifferentialEvent*[^][differential-event] is a unary
*FlexBuffers*[^][flexbuffers] batch containing one commitflow command:

```ts
Array<["sync.memoremix.com", "sts/0/databasin/commitflow", {
  markers: { [flow: string]: {
    viewpoint: string; sha384: string; blob: Uint8Array
  } }
}]>
```

Use the *command and route contract*[^][basin-timeline] and
*development checks*[^][development]. A separate thread will later copy
*CommitMarkers*[^][commit-marker] from the *Timeline*[^][timeline] into
*Flow*[^][flow] *Epilogues*[^][epilogue] and create recovery snapshots.
