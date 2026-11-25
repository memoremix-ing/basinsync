[selective-export]: <selective-export.json>

# Selective export

Bun 1.4.5; five alternating trials, cold caches, in-memory storage. Replace one
value in 100,000 entries. Both paths produce identical canonical root bytes and
three new objects. The full pass makes 394 GETs and 394 PUT calls; selective export
makes four GETs and three PUT calls. Median local time is 223 ms versus 10.7 ms;
these timings exclude network latency. *Raw trials*[~][selective-export].

`composableConsumer(c, { keyIndependent: true })` declares ordered associative
summary composition with `empty` as identity. Spreading/overriding a consumer does
not inherit that declaration. Without it, export retains flat callback semantics.
Key-dependent summaries can compose at unchanged paths; relocation regenerates
them from values. Canonical packing may require reading unchanged shallow edge
sets; reuse is not a promise of zero reads at every untouched boundary.

`TrieView.store`, stored-trie editors and their COW scopes retain source plans.
Unchanged stored subtrees remain opaque; changed boundaries repack canonically.
Changing local packing limits rebuilds rather than reusing prior packing.
