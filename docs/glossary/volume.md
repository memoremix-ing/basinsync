[strong-edge]: <strong-edge.md>
[sync-block]: <sync-block.md>
[trie]: <trie.md>
[weak-link]: <weak-link.md>

# Volume

A versioned graph of directories and file *SyncBlocks*[~][sync-block]. Directory contents
*tries*[~][trie] retain file blocks through *strong edges*[~][strong-edge]; block
boundary *weak links*[~][weak-link] expedite first/last page-trie reads.
