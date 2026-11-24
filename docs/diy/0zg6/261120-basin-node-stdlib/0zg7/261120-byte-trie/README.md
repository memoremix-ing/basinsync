---
prerequisites:
  - 0zg6/261120-basin-node-stdlib
  - 0zg6/261112-commit-marker-edges-with-node-promotion
---

[access-token]: <../../../../../glossary/access-token.md>
[basin]: <../../../../../glossary/basin.md>
[client-costs]: <benchmark/client-costs.md>
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
[promoted-costs]: <benchmark/promoted-costs.md>
[revision]: <../../../../../glossary/revision.md>
[shortcut-reads]: <benchmark/shortcut-reads.md>
[strong-edge]: <../../../../../glossary/strong-edge.md>
[subtree-cow]: <benchmark/subtree-cow.md>
[trie-format]: <../../../../../trie-format.md>
[trie-performance]: <benchmark/trie-performance.md>
[weak-link]: <../../../../../glossary/weak-link.md>

# Byte trie and volume

Use compressed byte keys, two nibble levels for 256-way branching, small sorted
key/value groups, and consumer-defined summaries. Values remain at their ordinary
trie positions. Headers and summaries permit pruning before fetching targets.
The *parent*[~][diy/0zg6/261120-basin-node-stdlib] defines the common node/edge contract.

## Trie layout

```ts
interface TrieNode_S0<
  MigrationsT extends {
    [index: number]: { Summary: unknown; Value: unknown };
  },
> extends BasinNode_S0<
  "sync.memoremix.com",
  ".trie-node/",
  {
    count: bigint; // number of values
    nullity: bigint; // number of values that are null
    degree: U32; // number of trie-handles (distinct from basin-degree)
    inlined: U32; // count of nested values up to edge boundaries
    prefix: null | Uint8Array; // (for trie-compression)
    keys: Bounds<Uint8Array>; // suffix bounds after ancestor bytes, before this node's prefix
    lengths: Bounds<U32>; // min/max lengths of those suffixes
  },
  {
    [IndexT in U32 & keyof MigrationsT]: [
      summary: MigrationsT[IndexT]["Summary"],
      // (must not have common byte-prefix -- extract that to the header)
      group: TrieGroup<MigrationsT[IndexT]["Value"]>,
      // (present when initial group overflows -- will hold all values except where key ends at prefix)
      ...nest: TrieNest<MigrationsT, IndexT>,
    ];
  }
> {}

interface TrieGroup<ValueT> {
  keys: Array<Uint8Array>; // 255 maximum; suffixes after consumed prefix/branch bytes
  values: Array<ValueT>; // (one per key)
}

type TrieNest<
  MigrationsT extends {
    [index: number]: { Summary: unknown; Value: unknown };
  },
  IndexT extends U32 & keyof MigrationsT,
> =
  | [members: null, edged: null]
  | [
      members: Array<
        // 16 maximum (i.e. one per nibble)
        | null
        | TrieGroup<MigrationsT[IndexT]["Value"]> // (must have common nibble-prefix)
        | Array<
            // 16 maximum (i.e. one per nibble)
            null | TrieNode_S0<MigrationsT>
          >
      >,
      edged: false, // (when nested nodes have no corresponding edges -- default unless inlined > 1280)
    ]
  | [
      members: Array<
        // 16 maximum (i.e. one per nibble)
        | null
        | TrieGroup<MigrationsT[IndexT]["Value"]> // (must have common nibble-prefix)
        | Array<
            // 16 maximum (i.e. one per nibble)
            null | BasinEdge_S0<TrieNode_S0<MigrationsT>>
          >
      >,
      edged: true, // (when no nodes are directly inlined members)
    ];

```

## Volume and directory shortcuts

```ts
interface SyncVolume_S0 extends BasinNode_S0<
  "sync.memoremix.com",
  ".sync-volume/",
  null,
  {
    0: [
      summary: null,
      device: TrieNode_S0<{
        0: {
          Summary: null;

          Value: [edge: BasinEdge_S0<SyncBlock_M0>];
        };
      }>,
      root: SyncDirectory_M0,
    ];
  }
> {}

type SyncDirectory_M0 = [
  folder: true,
  sha384: Uint8Array, // digest of UTF-8 basename-byte-sorted pairs: length-framed basename + child digest
  contents: {
    [basename: string]: SyncDirectory_M0 | SyncFile_M0;
  },
];

type SyncFile_M0 = [
  folder: false,
  brombergSL2: Uint8Array, // (cache of linked block's own digest)
  link: SyncLink_M0<SyncBlock_M0>,
];

type SyncLink_M0<LazyT extends BasinNode_S0<string, string>> = {
  height: U32;
  version: U32;
  entropy: Uint8Array;
  revision: string; // node allocation revision

  [Symbol.unscopables]?: LazyT;
};

```

## Blocks and sectors

```ts
interface SyncBlock_M0
  extends BasinNode_S0<
    "sync.memoremix.com",
    ".sync-block/",
    null,
    {
      0: [
        summary: null,
        // (lexidecmal trie keys encoded from sparse page numbers)
        pages: SyncSector_M0 | BasinEdge_S0<SyncSector_M0>,
        leaves: SyncLeaves_M0 | BasinEdge_S0<SyncLeaves_M0>, // dense, page-sorted; seven bits per level
        leading: Array<null | SyncLink_M0<SyncLeaves_M0>>, // basin height indexes; exclude vector root
        lagging: Array<null | SyncLink_M0<SyncLeaves_M0>>,
      ];
    }
  > {}

type SyncLeaves_M0 = VectorNode_S0<{
  0: {
    Summary: null;
    Value: [page: bigint, span: U32, link: SyncLink_M0<SyncSector_M0>];
  };
}>;

type SyncSector_M0 = TrieNode_S0<{
  0: {
    Summary: {
      brombergSL2: Uint8Array; // homomorphic checksum over the blobs in the page range
    };

    Value: [data: Uint8Array];
  };
}>;
```

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

The root's *basin query*[~][node] has *height*[~][node-height] and
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
    "height": 0,
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
key and reverse-key bounds each contain two empty byte strings, and length bounds
are `[0, 0]`. Its group contains one empty suffix and one null value.

## Strong retention and weak shortcuts

Use *strong basin edges*[~][strong-edge] as the retention graph declared to the
*Heap*[~][heap]. A *weak link*[~][weak-link] supplies a shortcut without adding a
retainer. The volume's `device` trie can strongly retain file blocks, while its
adjacent directory tree links directly to those blocks; each block can similarly
cache direct links to sector roots/leaves. Reads can follow shortcuts immediately,
without first traversing the retaining trie. Its strong references still need
explicit declaration to basinsync; serializing them inside opaque values does
not establish retention.

Tie shortcut data to the same trusted root/version and validate its expected
identity. Missing or stale shortcuts fall back to the authoritative trie; a
missing strongly retained target is a different failure. *Weak links*[~][weak-link]
must not contribute to retention *degree*[~][node-degree] or
*height*[~][node-height], nor be accidentally collected as declared edges.
Their address may still carry the target's *height*[~][node-height].

Store all page-sorted leaf shortcuts in a dense seven-bit/128-way
*vector*[~][diy/0zg6/261120-basin-node-stdlib/0zg7/261123-bitmapped-vector-trie].
Inline its root when packing permits; its ordinary *basin edges*[~][strong-edge]
retain shortcut-index nodes, while leaf links remain *weak*[~][weak-link].
`leading` and `lagging` cache the first/last paths' stored, non-root vector nodes,
indexed from *basin-node height*[~][node-height] zero; missing heights are null.
These links do not add retainers. Binary-search vector entries by page number.

Directory scaling proposal: make directories *basin nodes*[~][node], inlining
nested directories while packing permits and using *strong edges*[~][strong-edge]
when they spill. Index immediate children by UTF-8 basename with a byte trie, so
wide flat directories also split. Keep file links *weak*[~][weak-link] and the
device trie authoritative for file retention. This directory format is proposed;
the current directory tree remains inline.

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
const stored = await edit.store(); // full canonical export
```

`TrieEditor.from(basin, entries, consumer)` starts without stored data. Values
remain borrowed and must be immutable; keys are owned. Edits do no storage or
aggregation; export recomputes summaries and packs canonically. See the
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
index 0 and summary at index 1. Moving file paths also requires coordinating the
separate directory tree; file checksums and allocation links remain unchanged.

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

Handles are local plans, not a stored format. Export still materializes retained
entries and rebuilds canonically, refreshing consumer summaries. Full-key-dependent
summaries remain a consumer obligation for future selective export. Views share a
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

`Volume.mv`, `cp` and `rm` coordinate directory entries/hashes with device keys,
preserving empty directories and sharing retained blocks without reading file
bodies. Paths are absolute and destinations exact; parents must exist. Reject
collisions unless `replace: true` permits the same kind, with destination
directories empty. Copy includes a whole subtree; removing a nonempty directory
requires `recursive: true`. Reject root edits and moves/copies into descendants.
Each call returns a new snapshot after success; metadata export remains a full
canonical pass. Rust/Go expose equivalent operations.

```js
const moved = await volume.mv("/old", "/parent/new");
const copied = await moved.cp("/parent/new", "/copy");
const removed = await copied.rm("/parent/new", { recursive: true });
```

`Volume.update()` still reads files and rebuilds; `fromBlocks()` shares existing
block descriptors. The directory tree remains inline. Server-side retention
and collection govern eventual storage reclamation.

The *shortcut request traces*[~][shortcut-reads] show that the current binary-searched
leaf vector can add GETs, while adjacent file links can bypass the device trie.
Prefer measured object-fetch paths over logical branching-factor comparisons.

Pruning
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
