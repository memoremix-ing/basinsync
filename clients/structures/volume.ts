import { resolveOperation } from "./operation";
import {
  Basin,
  Edge,
  Node,
  Link,
  DOMAIN,
  check,
  utf8,
  concat,
  compare,
  equal,
  sha384,
  link,
  capability,
  object,
  validateNode,
  edgeFrom,
  query,
  distinct,
} from "./core";
import { TrieView } from "./trie-view";
import {
  Trie,
  Consumer,
  plain,
  Header,
  TRIE,
  composableConsumer,
} from "./trie";
import { encode, toReference, Reference } from "../flexbuffer";
import { encode as lex, decode as unlex } from "../lexidecimal";
import * as sl2 from "./bromberg";
export const VOLUME = ".sync-volume/",
  BLOCK = ".sync-block/",
  PAGE_SIZE = 4096;
export type Directory = [true, Uint8Array, Record<string, Directory | File>];
export type File = [false, Uint8Array, Edge];
export type SectorSummary = { brombergSL2: Uint8Array };
export const sectors: Consumer<[Uint8Array], SectorSummary> =
  composableConsumer<[Uint8Array], SectorSummary>(
    {
      migration: 0,
      empty: { brombergSL2: sl2.bytes(sl2.identity()) },
      entry: (_k, v) => {
        check(
          Array.isArray(v) && v.length === 1 && v[0] instanceof Uint8Array,
          "invalid page",
        );
        return { brombergSL2: sl2.hash(v[0]) };
      },
      combine: (s) => ({
        brombergSL2: sl2.combine(s.map((v) => v.brombergSL2)),
      }),
    },
    { keyIndependent: true },
  );
function path(value: string): string[] {
  check(
    value.isWellFormed() && value.startsWith("/") && !value.includes("\0"),
    "invalid absolute pathname",
  );
  const parts = value.slice(1).split("/");
  check(
    parts.every((v) => v.length > 0 && v !== "." && v !== ".."),
    "invalid pathname component",
  );
  return parts;
}
function lengthFrame(bytes: Uint8Array): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, bytes.length, true);
  return concat([b, bytes]);
}
async function directory(
  entries: Record<string, Directory | File>,
): Promise<Directory> {
  const ordered = Object.keys(entries).sort((a, b) =>
    compare(utf8(a), utf8(b)),
  );
  const content = ordered.map((name) => {
    const item = entries[name];
    return concat([
      lengthFrame(utf8(name)),
      new Uint8Array([item[0] ? 1 : 0]),
      lengthFrame(item[1]),
    ]);
  });
  return [true, await sha384(concat(content)), entries];
}
type DirectorySource = Node | Edge;
type StoredDirectory = [true, Uint8Array, number, number, DirectorySource];
type StoredEntry = StoredDirectory | File;
function directoryRefs(source: DirectorySource): Edge[] {
  if (Array.isArray(source)) return [source];
  if (source[3].degree === 0) return [];
  const scanTrie = (node: Node): Edge[] => {
    const values = (group: any) =>
      group.values.flatMap((v: StoredEntry) =>
        v[0] ? directoryRefs(v[4]) : [v[2]],
      );
    const refs = values(node[6][2]);
    for (const m of (node[6][3] as any[] | null) ?? [])
      if (m) {
        if (Array.isArray(m)) {
          for (const ch of m)
            if (ch)
              refs.push(...(Array.isArray(ch) ? [ch as Edge] : scanTrie(ch)));
        } else refs.push(...values(m));
      }
    return distinct(refs);
  };
  return scanTrie(source);
}
const directoryEntries = composableConsumer<StoredEntry, null>(
  {
    ...plain,
    edges: (v) => (v[0] ? directoryRefs(v[4]) : [v[2]]),
    trieInlineCost: (v) => 1 + (v[0] && !Array.isArray(v[4]) ? v[2] : 0),
    trieExternalize: async (b, v) =>
      v[0] && !Array.isArray(v[4])
        ? [true, v[1], v[2], v[3], await b.seal(v[4], directoryRefs(v[4]))]
        : v,
  },
  { keyIndependent: true },
);
type DirectoryHeader = { sha384: Uint8Array; inlined: number; nesting: number };
type DirectoryOrigin = {
  basin: Basin;
  source: Reference;
  h: DirectoryHeader;
  policy: string;
  entries?: Promise<Record<string, Directory | File>>;
  raw: Map<string, StoredEntry>;
};
const directoryOrigins = new WeakMap<Directory, DirectoryOrigin>();
const directoryPolicy = (b: Basin) => JSON.stringify(b.options);
function directoryHandle(basin: Basin, source: Reference): Directory {
  check(
    source.isVector() &&
      source.length() === 5 &&
      source.get(0).boolValue() === true,
    "invalid directory descriptor",
  );
  check(
    source.get(2).intValue() !== null && source.get(3).intValue() !== null,
    "invalid directory counters",
  );
  const h: DirectoryHeader = {
    sha384: object<Uint8Array>(source.get(1)),
    inlined: Number(source.get(2).intValue()),
    nesting: Number(source.get(3).intValue()),
  };
  check(
    h.sha384.length === 48 &&
      Number.isSafeInteger(h.inlined) &&
      h.inlined >= 0 &&
      Number.isSafeInteger(h.nesting) &&
      h.nesting >= 1,
    "invalid directory metadata",
  );
  const tree: Directory = [true, h.sha384, Object.create(null)];
  directoryOrigins.set(tree, {
    basin,
    source,
    h,
    policy: directoryPolicy(basin),
    raw: new Map(),
  });
  return tree;
}
async function readDirectory(
  tree: Directory,
): Promise<Record<string, Directory | File>> {
  const origin = directoryOrigins.get(tree);
  if (!origin) return tree[2];
  return (origin.entries ??= (async () => {
    const r = await sourceRef(origin.basin, origin.source.get(4));
    validateNode(r, TRIE);
    const entries: Record<string, Directory | File> = Object.create(null);
    for await (const [name, value] of new Trie(
      origin.basin,
      r,
      directoryEntries,
    ).entries()) {
      const n = new TextDecoder("utf-8", { fatal: true }).decode(name);
      origin.raw.set(n, value);
      entries[n] = value[0]
        ? directoryHandle(origin.basin, toReference(encode(value)))
        : value;
      if (value[0])
        check(equal(entries[n][1], value[1]), "directory digest mismatch");
    }
    return entries;
  })());
}
// Changed handles carry their stored ancestor separately from their current entries.
const changedOrigins = new WeakMap<Directory, Directory>();
type DirectoryBuild = {
  h: DirectoryHeader;
  node: () => Promise<Node>;
  edges: () => Promise<Edge[]>;
  seal: () => Promise<Edge>;
};
function once<T>(f: () => Promise<T>) {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
}
async function buildDirectory(
  basin: Basin,
  tree: Directory,
): Promise<DirectoryBuild> {
  const old = directoryOrigins.get(tree);
  if (old && old.policy === directoryPolicy(basin)) {
    const contents = trieSource(old.source.get(4));
    if (Array.isArray(contents)) basin.peek(contents);
    const node = once(async () =>
      object<Node>(
        Array.isArray(contents) ? await basin.load(contents) : contents,
      ),
    );
    const edges = once(async () => directoryRefs(await node()));
    return {
      h: old.h,
      node,
      edges,
      seal: once(async () =>
        Array.isArray(contents)
          ? contents
          : basin.seal(await node(), await edges()),
      ),
    };
  }
  const contents = await readDirectory(tree),
    children = new Map<string, DirectoryBuild>();
  for (const [name, v] of Object.entries(contents))
    if (v[0]) children.set(name, await buildDirectory(basin, v));
  const ancestor = changedOrigins.get(tree),
    origin = ancestor ? directoryOrigins.get(ancestor) : undefined;
  const make = async () => {
    const entries: [Uint8Array, StoredEntry][] = [];
    for (const [name, value] of Object.entries(contents)) {
      if (!value[0]) entries.push([utf8(name), value]);
      else {
        const child = children.get(name)!,
          cut = child.h.inlined >= 1280 || child.h.nesting >= 32,
          raw = origin?.raw.get(name),
          previous = ancestor
            ? (await readDirectory(ancestor))[name]
            : undefined;
        if (previous === value && raw?.[0] && Array.isArray(raw[4]) === cut)
          entries.push([utf8(name), raw]);
        else
          entries.push([
            utf8(name),
            [
              true,
              child.h.sha384,
              child.h.inlined,
              child.h.nesting,
              cut ? await child.seal() : await child.node(),
            ],
          ]);
      }
    }
    if (origin && origin.policy === directoryPolicy(basin)) {
      const r = await sourceRef(basin, origin.source.get(4));
      let view = TrieView.from(
        new Trie<StoredEntry, null>(basin, r, directoryEntries),
      );
      const names = new Set(Object.keys(contents));
      for (const name of origin.raw.keys())
        if (!names.has(name)) view = view.delete(utf8(name));
      for (const [k, value] of entries)
        if (origin.raw.get(new TextDecoder().decode(k)) !== value)
          view = view.set(k, value);
      return view.buildNode();
    }
    return Trie.buildNode(basin, entries, directoryEntries);
  };
  const trie = await make(),
    stats = directoryStats(trie.node);
  const h = { sha384: tree[1], ...stats },
    node = trie.node;
  return {
    h,
    node: async () => node,
    edges: async () => trie.edges,
    seal: once(() => basin.seal(node, trie.edges)),
  };
}
async function sourceRef(basin: Basin, source: Reference): Promise<Reference> {
  return source.isMap() ? source : basin.load(edgeFrom(source));
}
async function directoryContents(basin: Basin, descriptor: Reference) {
  return sourceRef(basin, descriptor.get(4));
}
function directoryStats(node: Node): { inlined: number; nesting: number } {
  let nesting = 1;
  const group = (g: any) => {
    for (const v of g.values as StoredEntry[])
      if (v[0] && !Array.isArray(v[4])) {
        nesting = Math.max(nesting, 1 + v[3]);
      }
  };
  const walk = (n: Node) => {
    group(n[6][2]);
    for (const m of (n[6][3] as any[] | null) ?? [])
      if (m) {
        if (Array.isArray(m)) {
          for (const ch of m) if (ch && !Array.isArray(ch)) walk(ch);
        } else group(m);
      }
  };
  walk(node);
  return { inlined: (node[5] as Header).inlined, nesting };
}
function trieSource(source: Reference): Reference | Edge {
  return source.isMap() ? source : edgeFrom(source);
}
export type BlockRoot = { edge: Edge; digest: Uint8Array };
export type PageLink = { prefix: Uint8Array; sha384: Uint8Array; link: Link };
async function pageSpine(
  basin: Basin,
  root: Node,
  last: boolean,
): Promise<Array<PageLink | null>> {
  const spine: Array<PageLink | null> = Array(root[3].height).fill(null);
  let n = root,
    base: Uint8Array = new Uint8Array();
  for (let depth = 0; depth < 256; depth++) {
    const h = n[5] as Header;
    if (!h.keys) return spine;
    const target = h.keys[last ? 1 : 0],
      prefix = h.prefix ?? new Uint8Array(),
      members = n[6][3] as any[] | null;
    if (!members || target.length === prefix.length) return spine;
    const byte = target[prefix.length],
      m = members[byte >> 4];
    if (!Array.isArray(m)) return spine;
    const ch = m[byte & 15] as Node | Edge | null;
    if (!ch) return spine;
    base = concat([base, prefix, new Uint8Array([byte])]);
    if (Array.isArray(ch)) {
      spine[ch[3].height] = {
        prefix: base,
        sha384: ch[6].sha384,
        link: link(ch),
      };
      if (ch[3].degree === 0) return spine;
      n = object<Node>(await basin.load(ch));
    } else n = ch;
  }
  throw Error("page trie nesting limit");
}
export async function buildBlock(
  basin: Basin,
  input: Iterable<[bigint, Uint8Array]>,
): Promise<BlockRoot> {
  const pages: [Uint8Array, [Uint8Array]][] = [];
  for (const [page, data] of input) {
    check(page >= 0n, "negative page");
    pages.push([utf8(lex(page)), [data]]);
  }
  const t = await Trie.buildNode(basin, pages, sectors),
    leading = await pageSpine(basin, t.node, false),
    lagging = await pageSpine(basin, t.node, true);
  const edged = (t.node[5] as Header).inlined > 1280,
    pagesRoot = edged ? await basin.seal(t.node, t.edges) : t.node,
    edges = edged ? [pagesRoot as Edge] : t.edges;
  const node = {
    0: Symbol.species,
    1: DOMAIN,
    2: BLOCK,
    3: query(
      edges,
      basin.options.maxDegree ?? 320,
      basin.options.maxHeight ?? 128,
    ),
    4: 0,
    5: null,
    6: [0, null, pagesRoot, leading, lagging],
  } as Node;
  return {
    edge: await basin.seal(node, edges),
    digest: t.node[6][1].brombergSL2,
  };
}
export type VolumeTransferOptions = { replace?: boolean };
export type VolumeRemoveOptions = { recursive?: boolean };
type DirectoryEntry = Directory | File;
async function entryAt(
  root: Directory,
  parts: readonly string[],
): Promise<DirectoryEntry> {
  let current: DirectoryEntry = root;
  for (const part of parts) {
    check(current[0], "parent is not a directory");
    const contents = await readDirectory(current);
    check(Object.hasOwn(contents, part), "missing pathname");
    current = contents[part];
  }
  return current;
}
async function changeEntry(
  root: Directory,
  parts: readonly string[],
  value?: DirectoryEntry,
  create = false,
): Promise<Directory> {
  const contents = Object.assign(
      Object.create(null),
      await readDirectory(root),
    ),
    name = parts[0];
  if (parts.length === 1) {
    if (value) {
      check(
        !contents[name] || contents[name][0] === value[0],
        "file/directory collision",
      );
      contents[name] = value;
    } else delete contents[name];
  } else {
    let child = contents[name];
    if (!child && create) child = await directory(Object.create(null));
    check(child?.[0], "parent is not a directory");
    contents[name] = await changeEntry(child, parts.slice(1), value, create);
  }
  const next = await directory(contents);
  const ancestor = directoryOrigins.has(root) ? root : changedOrigins.get(root);
  if (ancestor) changedOrigins.set(next, ancestor);
  return next;
}
async function sealVolume(basin: Basin, root: Directory): Promise<Volume> {
  const dir = await buildDirectory(basin, root),
    edged = dir.h.inlined > 1280 || dir.h.nesting > 32,
    contents = edged ? await dir.seal() : await dir.node(),
    edges = edged ? [contents as Edge] : await dir.edges();
  const descriptor: StoredDirectory = [
    true,
    dir.h.sha384,
    dir.h.inlined,
    dir.h.nesting,
    contents,
  ];
  const node = {
    0: Symbol.species,
    1: DOMAIN,
    2: VOLUME,
    3: query(
      edges,
      basin.options.maxDegree ?? 320,
      basin.options.maxHeight ?? 128,
    ),
    4: 0,
    5: null,
    6: [0, null, descriptor],
  } as Node;
  return new Volume(basin, await basin.seal(node, edges));
}
export class Volume {
  constructor(
    readonly basin: Basin,
    readonly root: Edge,
  ) {
    check(
      root[1] === DOMAIN && root[2] === VOLUME && root[6][0] === 0,
      "unsupported volume",
    );
  }
  static async build(
    basin: Basin,
    input: Iterable<[string, Uint8Array]>,
    directories: Iterable<string> = [],
  ): Promise<Volume> {
    const files: [string, BlockRoot][] = [];
    for (const [name, data] of input) {
      path(name);
      const pages: [bigint, Uint8Array][] = [];
      for (let at = 0; at < data.length; at += PAGE_SIZE)
        pages.push([BigInt(at / PAGE_SIZE), data.slice(at, at + PAGE_SIZE)]);
      files.push([name, await buildBlock(basin, pages)]);
    }
    return Volume.fromBlocks(basin, files, directories);
  }
  static async fromBlocks(
    basin: Basin,
    input: Iterable<[string, BlockRoot]>,
    directories: Iterable<string> = [],
  ): Promise<Volume> {
    const files = new Map<string, BlockRoot>();
    for (const [name, block] of input) {
      path(name);
      check(!files.has(name), "duplicate pathname");
      check(
        block.edge[2] === BLOCK && block.digest.length === 64,
        "invalid block descriptor",
      );
      files.set(name, block);
    }
    type Tree = Map<string, Tree | File>;
    const tree: Tree = new Map();
    for (const name of directories) {
      if (name === "/") continue;
      let dir = tree;
      for (const part of path(name)) {
        const old = dir.get(part);
        check(!old || old instanceof Map, "file/directory collision");
        if (old instanceof Map) dir = old;
        else {
          const next: Tree = new Map();
          dir.set(part, next);
          dir = next;
        }
      }
    }
    for (const [name, f] of files) {
      const parts = path(name);
      let dir = tree;
      for (const part of parts.slice(0, -1)) {
        const found = dir.get(part);
        if (found) {
          check(found instanceof Map, "file/directory collision");
          dir = found;
        } else {
          const next: Tree = new Map();
          dir.set(part, next);
          dir = next;
        }
      }
      const last = parts.at(-1)!;
      check(!dir.has(last), "file/directory collision");
      dir.set(last, [false, f.digest, f.edge]);
    }
    const finish = async (t: Tree): Promise<Directory> => {
      const entries: Record<string, Directory | File> = Object.create(null);
      for (const [name, item] of t)
        entries[name] = item instanceof Map ? await finish(item) : item;
      return directory(entries);
    };
    return sealVolume(basin, await finish(tree));
  }
  private async data(): Promise<Reference> {
    const r = await this.basin.load(this.root);
    validateNode(r, VOLUME);
    check(
      r.get("6").length() === 3 && r.get("6").get(0).intValue() === 0,
      "unsupported volume migration",
    );
    return r.get("6");
  }
  private async directoryEntry(
    name: string,
  ): Promise<{ entry: Reference; directory: boolean }> {
    const f = await this.data();
    let source = f.get(2);
    if (name === "/") return { entry: source, directory: true };
    const parts = path(name);
    for (let i = 0; i < parts.length; i++) {
      const trie = new Trie(
          this.basin,
          await directoryContents(this.basin, source),
          directoryEntries,
        ),
        ref = await trie.getView(utf8(parts[i]));
      check(ref, "missing pathname");
      const folder = ref.get(0).boolValue() === true;
      if (i === parts.length - 1) return { entry: ref, directory: folder };
      check(folder, "parent is not a directory");
      source = ref;
    }
    throw Error("missing pathname");
  }
  async stat(
    name = "/",
  ): Promise<
    | { kind: "directory"; sha384: Uint8Array }
    | { kind: "file"; brombergSL2: Uint8Array; edge: Edge }
  > {
    const { entry, directory } = await this.directoryEntry(name);
    if (directory)
      return {
        kind: "directory",
        sha384: object<Uint8Array>(entry.get(1)),
      };
    const f = object<File>(entry);
    return { kind: "file", brombergSL2: f[1], edge: f[2] };
  }
  async list(name = "/"): Promise<string[]> {
    const { entry, directory } = await this.directoryEntry(name);
    check(directory, "not a directory");
    const names: string[] = [];
    for await (const [k] of new Trie(
      this.basin,
      await directoryContents(this.basin, entry),
      directoryEntries,
    ).entries())
      names.push(new TextDecoder("utf-8", { fatal: true }).decode(k));
    return names;
  }
  private async openBlock(
    name: string,
    _shortcuts: boolean,
  ): Promise<{ footer: Reference; file: File }> {
    const { entry, directory } = await this.directoryEntry(name);
    check(!directory, "not a file");
    const file = object<File>(entry),
      block = await this.basin.load(file[2]);
    validateNode(block, BLOCK);
    const footer = block.get("6");
    check(
      footer.length() === 5 && footer.get(0).intValue() === 0,
      "unsupported block migration",
    );
    const pages = footer.get(2),
      sum = object<SectorSummary>(
        pages.isMap() ? pages.get("6").get(1) : pages.get(6).get("1"),
      );
    check(equal(sum.brombergSL2, file[1]), "block checksum mismatch");
    return { footer, file };
  }
  private async pageValue(
    footer: Reference,
    pages: Trie<[Uint8Array], SectorSummary>,
    full: Uint8Array,
    shortcuts: boolean,
  ): Promise<[Uint8Array] | undefined> {
    const direct = pages.getOrDefer(full);
    if (typeof direct !== "function") return direct;
    if (shortcuts && this.basin.storage.resolve) {
      let hints: PageLink[] = [];
      try {
        hints = [
          ...object<Array<PageLink | null>>(footer.get(3)),
          ...object<Array<PageLink | null>>(footer.get(4)),
        ]
          .filter(
            (h): h is PageLink =>
              h !== null &&
              h.prefix instanceof Uint8Array &&
              h.sha384 instanceof Uint8Array &&
              h.sha384.length === 48 &&
              h.link !== undefined &&
              Number.isInteger(h.link.height) &&
              full.length >= h.prefix.length &&
              equal(full.subarray(0, h.prefix.length), h.prefix),
          )
          .sort((a, b) => a.link.height - b.link.height);
      } catch {
        /* Ignore malformed optional hints. */
      }
      for (const hint of hints)
        try {
          const edge = await this.basin.storage.resolve(hint.link);
          if (!edge) continue;
          check(
            capability(link(edge)) === capability(hint.link) &&
              equal(edge[6].sha384, hint.sha384),
            "page shortcut identity mismatch",
          );
          const h = edge[5] as Header,
            k = full.subarray(hint.prefix.length);
          if (!h.keys || compare(k, h.keys[0]) < 0 || compare(k, h.keys[1]) > 0)
            continue;
          const value = await new Trie<[Uint8Array], SectorSummary>(
            this.basin,
            edge,
            sectors,
          ).get(k);
          if (value !== undefined) return value;
        } catch {
          /* An optional hint cannot replace strong traversal on failure. */
        }
    }
    return resolveOperation(direct);
  }
  async page(
    name: string,
    index: bigint,
    shortcuts = true,
  ): Promise<Uint8Array | undefined> {
    check(index >= 0n, "negative page");
    const { footer } = await this.openBlock(name, shortcuts);
    const pages = new Trie<[Uint8Array], SectorSummary>(
      this.basin,
      trieSource(footer.get(2)),
      sectors,
    );
    const value = await this.pageValue(
      footer,
      pages,
      utf8(lex(index)),
      shortcuts,
    );
    if (value === undefined) return undefined;
    check(value.length === 1 && value[0] instanceof Uint8Array, "invalid page");
    return value[0];
  }
  async read(
    name: string,
    options: { start?: number; length?: number; shortcuts?: boolean } = {},
  ): Promise<Uint8Array> {
    const { footer, file } = await this.openBlock(
      name,
      options.shortcuts !== false,
    );
    const pages = new Trie<[Uint8Array], SectorSummary>(
      this.basin,
      trieSource(footer.get(2)),
      sectors,
    );
    if (options.length !== undefined) {
      const start = options.start ?? 0,
        length = options.length;
      check(
        Number.isSafeInteger(start) &&
          start >= 0 &&
          Number.isSafeInteger(length) &&
          length >= 0 &&
          length <= (this.basin.options.maxBytes ?? 64 * 1024 * 1024),
        "invalid file range",
      );
      if (length === 0) return new Uint8Array();
      const root = footer.get(2);
      const header = object<Header>(root.isMap() ? root.get("5") : root.get(5));
      if (!header.keys) return new Uint8Array();
      const highest = unlex(
        new TextDecoder("utf-8", { fatal: true }).decode(header.keys[1]),
      );
      const first = BigInt(Math.floor(start / PAGE_SIZE)),
        last = (BigInt(start) + BigInt(length) - 1n) / BigInt(PAGE_SIZE);
      if (first > highest) return new Uint8Array();
      const boundedLast = last < highest ? last : highest;
      const out = new Uint8Array(
        Number(
          (boundedLast + 1n) * BigInt(PAGE_SIZE) - BigInt(start) <
            BigInt(length)
            ? (boundedLast + 1n) * BigInt(PAGE_SIZE) - BigInt(start)
            : BigInt(length),
        ),
      );
      let actual = out.length;
      for (let page = first; page <= boundedLast; page++) {
        const value = await this.pageValue(
          footer,
          pages,
          utf8(lex(page)),
          options.shortcuts !== false,
        );
        check(
          value &&
            value.length === 1 &&
            value[0] instanceof Uint8Array &&
            value[0].length > 0 &&
            value[0].length <= PAGE_SIZE,
          "missing/invalid page",
        );
        const offset = Number(page * BigInt(PAGE_SIZE) - BigInt(start)),
          from = Math.max(0, -offset),
          to = Math.min(value[0].length, out.length - offset);
        if (to > from)
          out.set(value[0].subarray(from, to), Math.max(0, offset));
        if (page === highest)
          actual = Math.min(actual, Math.max(0, offset + value[0].length));
      }
      return out.slice(0, actual);
    }
    const rows: [bigint, Uint8Array][] = [];
    for await (const [k, v] of pages.entries()) {
      check(
        v.length === 1 &&
          v[0] instanceof Uint8Array &&
          v[0].length > 0 &&
          v[0].length <= PAGE_SIZE,
        "invalid page",
      );
      const p = unlex(new TextDecoder("utf-8", { fatal: true }).decode(k));
      check(p >= 0n, "invalid page index");
      rows.push([p, v[0]]);
    }
    const end = rows.reduce((n, [p, b]) => {
      const e = p * BigInt(PAGE_SIZE) + BigInt(b.length);
      return e > n ? e : n;
    }, 0n);
    check(
      end <= BigInt(this.basin.options.maxBytes ?? 64 * 1024 * 1024),
      "file read byte limit",
    );
    const bytes = new Uint8Array(Number(end));
    for (const [p, b] of rows) bytes.set(b, Number(p) * PAGE_SIZE);
    check(equal(sl2.hash(bytes), file[1]), "file checksum mismatch");
    const start = options.start ?? 0,
      length = options.length ?? Math.max(0, bytes.length - start);
    check(
      Number.isSafeInteger(start) &&
        start >= 0 &&
        Number.isSafeInteger(length) &&
        length >= 0,
      "invalid file range",
    );
    return bytes.slice(start, start + length);
  }
  /** Exact destination pathname; unchanged blocks/links are shared. */
  async mv(
    from: string,
    to: string,
    options: VolumeTransferOptions = {},
  ): Promise<Volume> {
    return this.transfer(from, to, true, options);
  }
  /** Copy a file or a whole directory subtree; no file-body reads. */
  async cp(
    from: string,
    to: string,
    options: VolumeTransferOptions = {},
  ): Promise<Volume> {
    return this.transfer(from, to, false, options);
  }
  private async transfer(
    from: string,
    to: string,
    move: boolean,
    options: VolumeTransferOptions,
  ): Promise<Volume> {
    const a = path(from),
      b = path(to),
      footer = await this.data();
    let root = directoryHandle(this.basin, footer.get(2));
    const source = await entryAt(root, a);
    if (from === to) {
      check(move, "cannot copy onto itself");
      return this;
    }
    check(!to.startsWith(from + "/"), "destination is inside source");
    const parent = await entryAt(root, b.slice(0, -1));
    check(parent[0], "parent is not a directory");
    const name = b.at(-1)!,
      parentContents = await readDirectory(parent),
      target = Object.hasOwn(parentContents, name)
        ? parentContents[name]
        : undefined;
    if (target) {
      check(options.replace === true, "destination exists");
      check(source[0] === target[0], "file/directory collision");
      check(
        !target[0] || Object.keys(await readDirectory(target)).length === 0,
        "destination directory is not empty",
      );
    }
    if (move) root = await changeEntry(root, a);
    root = await changeEntry(root, b, source);
    return sealVolume(this.basin, root);
  }
  async rm(name: string, options: VolumeRemoveOptions = {}): Promise<Volume> {
    const parts = path(name),
      footer = await this.data();
    const root = directoryHandle(this.basin, footer.get(2)),
      source = await entryAt(root, parts);
    check(
      !source[0] ||
        options.recursive === true ||
        Object.keys(await readDirectory(source)).length === 0,
      "directory is not empty",
    );
    return sealVolume(this.basin, await changeEntry(root, parts));
  }
  async update(
    changes: Iterable<[string, Uint8Array | null]>,
  ): Promise<Volume> {
    const footer = await this.data();
    let root = directoryHandle(this.basin, footer.get(2));
    for (const [name, bytes] of changes) {
      const parts = path(name);
      if (bytes === null) {
        let parent: DirectoryEntry = root;
        let found = true;
        for (const part of parts) {
          if (!parent[0]) {
            found = false;
            break;
          }
          const contents = await readDirectory(parent);
          if (!Object.hasOwn(contents, part)) {
            found = false;
            break;
          }
          parent = contents[part];
        }
        if (found && !parent[0]) root = await changeEntry(root, parts);
      } else {
        const pages: [bigint, Uint8Array][] = [];
        for (let i = 0; i < bytes.length; i += PAGE_SIZE)
          pages.push([BigInt(i / PAGE_SIZE), bytes.slice(i, i + PAGE_SIZE)]);
        const block = await buildBlock(this.basin, pages);
        root = await changeEntry(
          root,
          parts,
          [false, block.digest, block.edge],
          true,
        );
      }
    }
    return sealVolume(this.basin, root);
  }
}
