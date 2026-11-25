# Content-defined chunking

Dividing bytes at boundaries selected from their contents, within size bounds.
Boundaries can resynchronize after insertions or deletions, preserving unchanged
chunks even when their byte offsets move. The boundary fingerprint chooses cuts;
it need not be the checksum or content identity used to compare stored data.
