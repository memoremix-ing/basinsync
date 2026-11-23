---
prerequisites:
  - 0zg6/261120-trie
  - 0zg6/261112-commit-marker-edges-with-node-promotion
---

[basin]: <../../../../../glossary/basin.md>
[diy/0zg6/261120-trie]: <../../README.md>
[heap-protocol]: <../../../../../heap-protocol.md>
[node]: <../../../../../glossary/node.md>
[object-keys]: <../../../../../object-keys.md>
[revision]: <../../../../../glossary/revision.md>
[strong-edge]: <../../../../../glossary/strong-edge.md>
[trie-format]: <../../../../../trie-format.md>
[trie-performance]: <benchmark/trie-performance.md>
[weak-link]: <../../../../../glossary/weak-link.md>

# Trie and volume implementations

Implement the *proposal's*[~][diy/0zg6/261120-trie] *format 0*[~][trie-format]
in TypeScript, Rust, then Go. Share fixtures rather than assuming that agreement
within one encoder proves interchange.

```ts
const basin = new Basin(storage);
const trie = await Trie.build(basin, [["abcd", value]], consumer);
const found = await trie.get("abcd");
const next = await trie.update([["abcd", { delete: true }]]);

const volume = await Volume.build(basin, [["/notes/a", bytes]]);
const part = await volume.read("/notes/a", { start: 4090, length: 30 });

const block = await buildBlock(basin, [[2n ** 200n, bytes]]);
const sparse = await Volume.fromBlocks(basin, [["/pages", block]]);
const page = await sparse.page("/pages", 2n ** 200n);
```

Storage accepts bytes plus outgoing *strong basin edges*[~][strong-edge]; publish
parents only after their children are stored and their allocation
*revisions*[~][revision] are known. The Fetch adapter uses
*reservations*[~][heap-protocol], conditional uploads, and marker publication.
Cold clients can derive *object keys*[~][object-keys] from pointers and obtain
signed reads from an edge service without a central *Basin*[~][basin] lookup. Inject a
capability resolver into the Fetch adapter when read actions are not cached. *Weak shortcuts*[~][weak-link] accelerate navigation without
contributing retainers.

Expose borrowed values for lazy parsing, owned reads for independent data, and
summary/prefix filters before fetching *basin nodes*[~][node]. TypeScript uses
Web Crypto and browser APIs; the Rust structures crate builds independently for
Wasm. Treat borrowed byte views as immutable.

Exercise empty/null keys, 63/64 and 1280/1281 boundaries, canonical deletion,
Unicode basenames, consumer migrations, shared descendants, corrupted payloads,
partial reads, shortcut misses, and old snapshots. Cross-read every language's
output with every other implementation. Then verify real storage, promotion,
staging sweeps, publication and restart against the server.

Updates currently rebuild from contents; immutable objects are reused. Pruning
and partial reads remain selective. Readers bound nesting to 256 trie levels;
default object/full-file limits are 64 MiB, with a 16 MiB/128-object read cache.

```sh
cargo test -p basinsync-structures
cargo check -p basinsync-structures --target wasm32-unknown-unknown
cargo build -p basinsync-structures --example fixture
(cd go/structures && go test ./... && go build -o ../../.local/structures-go ./cmd/fixture)
bun run test:structures:interop
bun clients/structures-integration.ts
```

Compare the three libraries using the *CPU and storage read measurements*[~][trie-performance].
