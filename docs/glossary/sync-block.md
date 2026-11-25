[crc64nvme]: <crc64nvme.md>
[node]: <node.md>
[trie]: <trie.md>

# SyncBlock

A *basin node*[~][node] representing file bytes as a content-defined prefix and a
page-defined suffix, each held in a *byte trie*[~][trie]. Either may be empty.
Its whole-file *CRC64NVME*[~][crc64nvme] digest composes the two byte sequences in order.
