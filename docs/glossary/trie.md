[node]: <node.md>
[trie-format]: <../trie-format.md>

# Trie

A compressed byte-key structure with two 16-slot nibble levels per branch.
Local trie nodes pack into *basin nodes*[~][node]; replicated bounds and
consumer summaries allow pruning before fetching. See the *versioned format*[~][trie-format].
