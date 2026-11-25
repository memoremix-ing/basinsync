---
prerequisites:
  - 0zg6/261120-basin-node-stdlib
  - 0zg6/261112-commit-marker-edges-with-node-promotion
---

[access-token]: <../../../../../glossary/access-token.md>
[basin]: <../../../../../glossary/basin.md>
[client-costs]: <benchmark/client-costs.md>
[directory-descriptors]: <benchmark/directory-descriptors.md>
[diy/0zg6/261120-basin-node-stdlib]: <../../README.md>
[diy/0zg6/261120-basin-node-stdlib/0zg7/261123-bitmapped-vector-trie]: <../261123-bitmapped-vector-trie/README.md>
[envbuf]: <../../../../../glossary/envbuf.md>
[flexbuffers]: <../../../../../glossary/flexbuffers.md>
[flow]: <../../../../../glossary/flow.md>
[heap]: <../../../../../glossary/heap.md>
[heap-protocol]: <../../../../../heap-protocol.md>
[incremental-edits]: <../261123-bitmapped-vector-trie/benchmark/incremental-edits.md>
[json0]: <../../../../../glossary/json0.md>
[node]: <../../../../../glossary/node.md>
[node-degree]: <../../../../../glossary/node-degree.md>
[node-height]: <../../../../../glossary/node-height.md>
[object-keys]: <../../../../../object-keys.md>
[owner-mutation]: <benchmark/owner-mutation.md>
[page-spines]: <benchmark/page-spines.md>
[promoted-costs]: <benchmark/promoted-costs.md>
[revision]: <../../../../../glossary/revision.md>
[selective-export]: <benchmark/selective-export.md>
[selective-ordered]: <../../benchmark/selective-ordered.md>
[shortcut-navigation]: <benchmark/shortcut-navigation.md>
[shortcut-reads]: <benchmark/shortcut-reads.md>
[strong-edge]: <../../../../../glossary/strong-edge.md>
[subtree-cow]: <benchmark/subtree-cow.md>
[trie-format]: <../../../../../trie-format.md>
[trie-performance]: <benchmark/trie-performance.md>
[trie.d]: <trie.d.ts>
[weak-link]: <../../../../../glossary/weak-link.md>

# Byte trie and volume

Use compressed byte keys, two nibble levels for 256-way branching, small sorted
key/value groups, and consumer-defined summaries. Values remain at their ordinary
trie positions. Headers and summaries permit pruning before fetching targets.
The *parent*[~][diy/0zg6/261120-basin-node-stdlib] defines the common node/edge contract.

*Trie and volume schema declarations*[~][trie.d].

## Canonical form

Groups store the unconsumed key suffix: after branches consume byte `ab` from
key `ab cd`, the group stores `cd`. Common byte prefixes move into the header.
Splitting and collapsing are canonical functions of the remaining contents;
inserting 256 keys then deleting one yields the same shape as directly inserting
those remaining 255. Empty structural children disappear, whether inline or behind
*basin edges*[~][strong-edge].

Structural schema (slot 4), consumer migration (the first element of slot 6),
and *basin-node*[~][node] id version (`edge.footer.version`) are independent.
Slot 6 stores the selected migration, not all footer variants.

## Empty aggregates

`Bounds<T>` is `null` when there are no observations; otherwise it contains the
inclusive minimum and maximum. Aggregation ignores `null` bounds and returns
`null` if every input is empty. Empty bounds must not use fabricated zeroes or
empty byte strings, which can be genuine observations.

Only a root may represent an empty trie. Its header has `count = nullity = 0n`,
`degree = inlined = 0`, `prefix = null`, and `keys = lengths = null`.
Its selected footer is `[migration, emptySummary, { keys: [], values: [] }, null, null]`.
Each consumer migration defines its canonical `emptySummary`; it is not
necessarily `null`.

An edge-free root's *basin query*[~][node] has *height*[~][node-height] one,
*degree*[~][node-degree] zero, `breadth = 0n`, and all four descendant bounds
(`rotations`, `versions`, `schemas`, `migrations`) null. Those descendant bounds
are also null on a nonempty node with no *basin edges*[~][strong-edge]; they
aggregate edge targets, not the current node's own version tags.

For migration 0 with a null empty summary, the root in
*JSON0*[~][json0] is:

```json
{
  "0": "0#species",
  "1": "sync.memoremix.com",
  "2": ".trie-node/",
  "3": {
    "height": 1,
    "degree": 0,
    "breadth": "0x0",
    "rotations": null,
    "versions": null,
    "schemas": null,
    "migrations": null
  },
  "4": 0,
  "5": {
    "count": "0x0",
    "nullity": "0x0",
    "degree": 0,
    "inlined": 0,
    "prefix": null,
    "keys": null,
    "lengths": null
  },
  "6": [0, null, { "keys": [], "values": [] }, null, null]
}
```

An empty-byte key with a null value is a nonempty trie: `count = nullity = 1n`,
key bounds contain two empty byte strings, and length bounds
are `[0, 0]`. Its group contains one empty suffix and one null value.

## Strong retention and weak shortcuts

Use *strong basin edges*[~][strong-edge] as the retention graph declared to the
*Heap*[~][heap]. Directory file entries directly retain blocks; contents tries
retain nested directory contents. Declare these references explicitly to basinsync;
serializing them inside opaque values does not establish retention.

Tie shortcut data to the same trusted root/version and validate its expected
identity. Missing or stale shortcuts fall back to the authoritative trie; a
missing strongly retained target is a different failure. *Weak links*[~][weak-link]
must not contribute to retention *degree*[~][node-degree] or
*height*[~][node-height], nor be accidentally collected as declared edges.
Their address may still carry the target's *height*[~][node-height].

Each file block concatenates a content-defined prefix trie and a page-defined suffix
trie, either of which may be empty. The suffix declares its page size. File digests
compose both halves in byte order. Page-only builders leave the prefix empty.

Each block's `leading` and `lagging` spines point to stored, non-root page-trie
nodes on its first/last paths, indexed by *basin-node height*[~][node-height];
missing heights are null. Each *weak hint*[~][weak-link] carries the incoming key
prefix, allocation link, and SHA-384 of the target's complete stored *EnvBuf*[~][envbuf].
The digest pins resolver-provided descriptors to the trusted block; verify it
against fetched bytes. Remove the prefix and check target bounds before reading.
Missing/stale hints fall back to strong traversal; ready page reads need no shortcut lookup.

A directory is a `true`-tagged tuple whose UTF-8 basename contents trie may be
inline or an *edge*[~][strong-edge]. That trie handles packing, search and retention.
Directory hashes retain basename/kind/child-digest framing. File entries carry strong block edges.

Budget inline directory contents against 1,280 entries and nesting 32. Count along
inline trie/directory paths; a stored contents-trie edge ends that inline path.
A directory entry costs one plus the inline entries in its child contents; an
edged child costs one. Apply that cost at every stored contents-trie boundary,
including groups with fewer than 255 names; expand/split groups before sealing
children. Externalize a prefix-ending directory's contents if its outgoing edges
would exceed the degree limit. Mirror the inline count in the descriptor. These
physical rewrites preserve the entry's logical digest and consumer summary.
Seal child contents when nesting, size or physical degree requires it. The
basename trie independently pages wide directories. `stat` reads metadata and
`list` scans the requested contents trie.

Each page-range summary carries `size: bigint`, the sum of blob bytes, excluding
keys and envelopes. Replicate it across *basin edges*[~][strong-edge] so readers
can skip byte ranges without fetching targets. Missing sparse page IDs contribute
no bytes to this sum; fixed-page file offsets retain their zero-filled grid semantics.

Before choosing a shortcut layout, measure first-useful-result latency, fetched
bytes, request count, and update churn against ordinary trie traversal. Keep
content identity and consumer aggregation independent of allocation details.

## Implementations

Implement *format 0*[~][trie-format]
in TypeScript, Rust, then Go. Share fixtures rather than assuming that agreement
within one encoder proves interchange.

```js
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
Partition nibble buckets in one pass and derive common prefixes/key bounds from
sorted endpoints. Carry a byte offset through deferred reads. See the
*implementation measurements*[~][promoted-costs].

TypeScript's `getOrDefer` / `getViewOrDefer` return ready values synchronously,
or a lazy generator function when I/O is needed; `get` / `getView` retain their
Promise APIs. Resume deferred reads with:

```js
const op = trie.getOrDefer(key);
const value = typeof op === "function" ? await resolveOperation(op) : op;
```

Compare logical traversal separately from serialization and storage using the
*client cost measurements*[~][client-costs].

Exercise empty/null keys, 255/256 and 1280/1281 boundaries, canonical deletion,
Unicode basenames, consumer migrations, shared descendants, corrupted payloads,
partial reads, shortcut misses, and old snapshots. Cross-read every language's
output with every other implementation. Then verify real storage, promotion,
staging sweeps, publication and restart against the server.

Stored updates rebuild from contents; immutable objects are reused. TypeScript
logical editing instead uses path-copied snapshots:

```js
let edit = await trie.edit(); // materializes existing contents once
const prior = edit;
edit = edit.set("abcd", value).delete("cdef");
const stored = await edit.store(); // canonical export; reuses compatible stored subtrees
```

`TrieEditor.from(basin, entries, consumer)` starts without stored data. Values
remain borrowed and must be immutable; keys are owned. Edits do no storage or
aggregation; export packs canonically and can reuse compatible stored subtrees. See the
*incremental-edit measurements*[~][incremental-edits].

Stored bytes are immutable; builders use mutable assembly objects. In TypeScript,
stored `get()` returns owned value copies, while `getView()` exposes borrowed views
that must remain read-only: mutation can affect cached reads until reload. Editor
structure is path-copied, but payloads are borrowed across snapshots; `readonly` does
not deep-freeze objects, typed arrays or descriptors.

## Prefix editing and COW

TypeScript editors expose `subtree`, `splitPrefix`, `deletePrefix`, `graftPrefix`,
`copyPrefix` and `movePrefix`. Handles strip the selected prefix and share relative
branches; only boundary repair rebuilds small leaf groups.

```js
const { subtree, rest } = edit.splitPrefix(utf8("/old/"));
const moved = rest.graftPrefix(utf8("/new/"), subtree);
const copied = edit.copyPrefix(utf8("/old/"), utf8("/copy/"));
const removed = edit.deletePrefix(utf8("/old/"));
```

Graft requires an empty destination unless `"replace"` explicitly removes its range.
Copy/move reject missing sources and destinations inside them; moving onto itself
is a no-op. These are byte prefixes: use `/dir/` to distinguish `/dir2/`.
Stored export rebuilds queries, headers and consumer summaries for the new keys;
logical handles defer that work until export. The footer starts with migration at
index 0 and summary at index 1. Volume filesystem operations instead relocate
directory entries and contents handles; file checksums and block edges remain unchanged.

`TrieView.from(trie)` provides lazy equivalents, recording source snapshots,
prefix mounts/tombstones and point overrides. Resolve the longest matching prefix;
prune exclusions before fetching, then merge ordered source scans. Graft/copy/move
are async because collision/source checks may load a boundary path. Explicit
replace-grafts, splits and drops do no storage I/O.

```js
const view = TrieView.from(trie);
const { subtree, rest } = view.splitPrefix(utf8("/old/"));
const moved = await rest.graftPrefix(utf8("/new/"), subtree, "replace");
const stored = await moved.store();
```

Handles are local plans, not a stored format. *Selective export*[~][selective-export]
reuses unchanged subtrees for explicitly composable consumer summaries. Other
consumers keep the full pass. Relocation regenerates key-dependent summaries. Views share a
storage/consumer context and bound nesting to 256. Treat view/editor payloads as
borrowed and immutable. Eager logical `size` rejects
unsafe integers. Stored counts remain bigint.

For scoped COW, `produceTrie` offers owned `get`, mutable clone-on-first-`edit`,
path-copy `updateIn` and prefix operations. Exceptions discard the recipe; sync
recipes return an editor, async recipes a Promise. Inputs remain immutable;
assigned values and escaped working copies cannot mutate the returned snapshot.
Only draft mutations are used; recipe return values are ignored.
Use `{ mutation: "owned" }` with either COW entrypoint to copy structural nodes on
first write, then mutate privately owned nodes. Persistent path-copying remains
the default. Concurrent recipes use different owner tokens. Snapshots, iterators
and prefix splices rotate ownership before exposing shared structure; subsequent
writes copy again. Structural write failures close the builder.

`editor.mutate()` offers a structure-only builder with `snapshot`, `finish` and
`abort`; payloads retain the editor's borrowed immutable contract. Use the COW
entrypoints for payload ownership. Proxy drafts coalesce payload edits independently
of structural mutation. Owners are local and do not change the stored format.
Returning a snapshot does not publish it or resolve competing publications.
See the *ownership measurements*[~][owner-mutation] for isolated costs and batch-size effects.

```js
const next = produceTrie(edit, draft => {
  draft.updateIn("/file", ["meta", "mode"], () => 0o644);
}, { keyEncoding: "utf8", mutation: "owned" });
```

Use explicit path updates in the core; opt into `produceTrieProxy` for suitable
UI edits. Both are supported public entrypoints. Proxy drafts support nested
property writes and explicit operations:

```js
const next = produceTrieProxy(edit, (draft, operations) => {
  draft["/file"].meta.mode = 0o644;
  operations.deletePrefix("/obsolete/");
}, { keyEncoding: "utf8" });
```

Both default to whole-hex keys; UTF-8 mode rejects malformed text. COW supports
acyclic plain records, dense arrays, primitives except undefined, and byte arrays. Proxy drafts are
revoked on close; their bytes are atomic read-only views (`at`, `slice`, iteration).
Replace byte fields and use array `splice` instead of deleting indices. Accessors,
nonenumerable/symbol property keys and custom prototypes are unsupported.
See the *subtree/COW experiments*[~][subtree-cow] for performance and code costs.

`Volume.mv`, `cp` and `rm` update directory entries and ancestor hashes,
preserving empty directories and sharing retained blocks without reading file
bodies. Paths are absolute and destinations exact; parents must exist. Reject
collisions unless `replace: true` permits the same kind, with destination
directories empty. Copy includes a whole subtree; removing a nonempty directory
requires `recursive: true`. Reject root edits and moves/copies into descendants.
Each call returns a new snapshot after success. TypeScript selectively exports
unchanged subdirectories; Rust/Go expose equivalent filesystem operations.

```js
const moved = await volume.mv("/old", "/parent/new");
const copied = await moved.cp("/parent/new", "/copy");
const removed = await copied.rm("/parent/new", { recursive: true });
```

`Volume.update()` rebuilds changed file blocks and reuses unchanged descriptors.
Directory edits open affected paths and reuse untouched contents subtries;
ancestor hashes still require their immediate names and child digests. Server-side retention
and collection govern eventual storage reclamation.

The *initial shortcut traces*[~][shortcut-reads] exposed extra secondary-index
GETs. The *earlier navigation traces*[~][shortcut-navigation] measured the prior layout.
The *page-spine traces*[~][page-spines] exercise the current retention graph and
boundary paths. Prefer measured object-fetch paths over logical
branching-factor comparisons.

Pruning and partial reads remain selective. Current readers cap trie nesting at
256 levels to bound malformed-input recursion; compressed prefixes
consume many key bytes at once, and each directory has its own basename trie.
This is not a volume-wide entry count or pathname-length limit.

The configurable 64 MiB byte budget limits one stored object and one materialized
file read (or requested range), not a volume or its total file sizes. Larger files
can be read page-by-page or in bounded ranges. The configurable 16 MiB cache holds
at most 128 objects; eviction causes refetching, not data loss, and an object larger
than that budget is read without being retained. Physical *height*[~][node-height]
and *degree*[~][node-degree] limits apply independently.

Compare the three libraries using the *CPU and storage read measurements*[~][trie-performance].

The default inlining trigger is 1,280 values for tries, vectors and block
packing; vector `bits`, physical degree/height and object-byte limits are configurable.
Trie groups cap at 255 entries. Small high-nibble groups can remain inline after
larger children are sealed, so 1,280 is not a strict object-wide bound for ordinary
byte tries. Directory contents use the weighted, per-body limit above.

Page boundary spines target the authoritative page trie directly.
The *selective export measurements*[~][selective-ordered] separate directory and
ancestor work from unchanged bodies; earlier measurements used the prior layout.
Current *descriptor export measurements*[~][directory-descriptors] include the
weighted contents-trie packing.
