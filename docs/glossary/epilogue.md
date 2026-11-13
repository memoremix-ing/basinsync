[commit-marker]: <commit-marker.md>
[promotion-sign]: <promotion-sign.md>
[viewpoint]: <viewpoint.md>

# Epilogue

The gapless series of *CommitMarkers*[^][commit-marker], starting at
*Viewpoint*[^][viewpoint] zero. Uploaded keys decrease lexicographically as
*viewpoints*[^][viewpoint] increase, placing the latest *marker*[^][commit-marker] at the minimum key.

*PromotionSigns*[^][promotion-sign] occupy uncomplemented positions, sorting after
all *markers*[^][commit-marker]. Ignore signs when discovering the latest
*marker*[^][commit-marker], including when no *markers*[^][commit-marker] remain.
