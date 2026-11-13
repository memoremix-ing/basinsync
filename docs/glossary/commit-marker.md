[conditional-write]: <conditional-write.md>
[promotion-sign]: <promotion-sign.md>
[viewpoint]: <viewpoint.md>

# CommitMarker

The opaque blob committed at one *Viewpoint*[^][viewpoint]. *Conditional creation*[^][conditional-write]
makes it immutable and first-writer-wins.

Its *PromotionSign*[^][promotion-sign] certifies that the entire graph is promoted.
