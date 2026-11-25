[dolt-chunking]: <https://www.dolthub.com/blog/2022-06-27-prolly-chunker/>
[strong-edge]: <strong-edge.md>

# Prolly tree

An ordered tree whose chunk boundaries are deterministic functions of its keys,
contents and chunking policy. Local boundary decisions help preserve unchanged
chunks across edits; *strong edges*[~][strong-edge] retain the resulting DAG.
Hard chunk limits and adversarial inputs can still cause extended rechunking.
See Dolt's *chunking design*[~][dolt-chunking].
