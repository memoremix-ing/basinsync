[content-defined-chunking]: <../../../../../glossary/content-defined-chunking.md>
[crc64nvme]: <../../../../../glossary/crc64nvme.md>
[envbuf]: <../../../../../glossary/envbuf.md>
[flexbuffers]: <../../../../../glossary/flexbuffers.md>
[lexidecimal]: <../../../../../glossary/lexidecimal.md>
[node]: <../../../../../glossary/node.md>
[trie.d]: <../../0zg7/261120-byte-trie/trie.d.ts>

# Two-trie block format

The *declarations*[~][trie.d] retain structural schema zero and sector consumer
migration one. Block consumer migration two stores this *basin node*[~][node] as
an *EnvBuf-wrapped*[~][envbuf] *FlexBuffers map*[~][flexbuffers]:

```ts
{
  0: Symbol.species, 1: "sync.memoremix.com", 2: ".sync-block/",
  3: { height, degree }, 4: 0,
  5: { pageSize },
  6: [2, null, [contentDefinedTrie, pageDefinedTrie], leading, lagging]
}
```

Both roots are present, inline or edged; empty tries have size zero and the empty
checksum. Account for both roots when applying block inlining/degree limits.
The content trie orders nonempty chunks by one-based *Lexidecimal*[~][lexidecimal]
ordinals. The page trie uses zero-based page indexes relative to the suffix and the
block's positive `pageSize` stride. Dense files fill every page except the last. Raw sparse
page access remains separate from dense byte-file diffing. The Turso VFS accepts
only an empty prefix and its configured page size; page updates preserve the prefix.

Each trie summary stores `size` and *CRC64NVME*[~][crc64nvme]. Compose the two summaries
in file order. Full reads verify that checksum; partial reads retain object integrity
checks. Diffing prunes matching object hashes and compares ordered chunk contents,
then refines unmatched spans; it never treats CRC equality alone as proof of equality.
Content-defined edits currently rechunk/build the prefix; selective incremental
rechunking remains an optimization to pursue.

The default *content-defined chunker*[~][content-defined-chunking] uses 16/64/256 KiB
minimum/target/maximum chunks and unsigned 32-bit arithmetic. Generate a 256-entry
Gear table from seed `0x9e3779b9` using xorshift steps `<<13`, `>>>17`, `<<5`.
Consume bytes with `hash = (hash << 1) + table[byte]`. After the minimum, test:

```text
boundary = hash
boundary ^= boundary >>> 16; boundary *= 0x7feb352d
boundary ^= boundary >>> 15; boundary *= 0x846ca68b
boundary ^= boundary >>> 16
close when boundary & (target - 1) == 0
```

Always close at the maximum. Also close before a changed byte following a run of
at least 64 identical bytes once the minimum is reached. Reset hash/run state at
boundaries, preserving it across caller input fragments. Other policies are caller
choices; readers interpret the stored chunks without needing the chunker policy.
