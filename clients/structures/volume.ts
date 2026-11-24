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
  nodeView,
  nodeBytes,
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
import { pack } from "./packed";
import { Vector, vectorBoundaryLinks } from "./vector";
import { encode, Reference } from "../flexbuffer";
import { encode as lex, decode as unlex } from "../lexidecimal";
import * as sl2 from "./bromberg";
export const VOLUME = ".sync-volume/",
  BLOCK = ".sync-block/",
  DIRECTORY = ".sync-directory/",
  PAGE_SIZE = 4096;
export type Directory = [true, Uint8Array, Record<string, Directory | File>];
export type File = [false, Uint8Array, Link];
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
export type LeafSummary = { pages: null | [bigint, bigint] };
export const leafShortcuts = composableConsumer<
  [bigint, number, Link],
  LeafSummary
>(
  {
    migration: 0,
    empty: { pages: null },
    entry: (_k, v) => ({ pages: [v[0], v[0] + BigInt(v[1]) - 1n] }),
    combine: (s) => {
      let lo: bigint | undefined, hi: bigint | undefined;
      for (const { pages } of s)
        if (pages) {
          if (lo === undefined || pages[0] < lo) lo = pages[0];
          if (hi === undefined || pages[1] > hi) hi = pages[1];
        }
      return { pages: lo === undefined ? null : [lo, hi!] };
    },
  },
  { keyIndependent: true },
);
export const devices: Consumer<[Edge], null> = composableConsumer<[Edge], null>(
  {
    ...plain,
    edges: (v) => {
      check(Array.isArray(v) && v.length === 1, "invalid device value");
      return [v[0]];
    },
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
type StoredEntry = [true, Uint8Array, DirectorySource] | File;
function directoryRefs(source: DirectorySource): Edge[] {
  if (Array.isArray(source)) return [source];
  if (source[3].degree === 0) return [];
  const scanTrie = (node: Node): Edge[] => {
    const values = (group: any) =>
      group.values.flatMap((v: StoredEntry) =>
        v[0] ? directoryRefs(v[2]) : [],
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
  return scanTrie(source[6][2] as Node);
}
const directoryEntries = composableConsumer<StoredEntry, null>(
  { ...plain, edges: (v) => (v[0] ? directoryRefs(v[2]) : []) },
  { keyIndependent: true },
);
async function buildDirectory(
  basin: Basin,
  tree: Directory,
): Promise<{ node: Node; edges: Edge[] }> {
  const children = new Map<string, { node: Node; edges: Edge[] }>();
  for (const [name, value] of Object.entries(tree[2]))
    if (value[0]) children.set(name, await buildDirectory(basin, value));
  const nested = [...children.values()],
    total =
      Object.keys(tree[2]).length +
      nested.reduce((n, c) => n + (c.node[5] as any).inlined, 0),
    nesting = 1 + Math.max(0, ...nested.map((c) => (c.node[5] as any).nesting));
  const cut =
    total > 1280 ||
    nesting > 32 ||
    distinct(nested.flatMap((c) => c.edges)).length >
      (basin.options.maxDegree ?? 320);
  const entries: [Uint8Array, StoredEntry][] = [];
  for (const [name, value] of Object.entries(tree[2])) {
    if (!value[0]) entries.push([utf8(name), value]);
    else {
      const c = children.get(name)!;
      entries.push([
        utf8(name),
        [true, value[1], cut ? await basin.seal(c.node, c.edges) : c.node],
      ]);
    }
  }
  const trie = await Trie.buildNode(basin, entries, directoryEntries);
  const node = {
    0: Symbol.species,
    1: DOMAIN,
    2: DIRECTORY,
    3: trie.node[3],
    4: 0,
    5: {
      sha384: tree[1],
      inlined:
        trie.node[5].inlined +
        (cut ? 0 : nested.reduce((n, c) => n + (c.node[5] as any).inlined, 0)),
      nesting: cut ? 1 : nesting,
    },
    6: [0, null, trie.node],
  } as Node;
  return { node, edges: trie.edges };
}
async function sourceRef(basin: Basin, source: Reference): Promise<Reference> {
  return source.isMap() ? source : basin.load(edgeFrom(source));
}
async function directoryContents(basin: Basin, source: Reference) {
  const r = await sourceRef(basin, source);
  validateNode(r, DIRECTORY);
  check(
    r.get("6").length() === 3 && r.get("6").get(0).intValue() === 0,
    "unsupported directory",
  );
  return r.get("6").get(2);
}
function trieSource(source: Reference): Reference | Edge {
  return source.isMap() ? source : edgeFrom(source);
}
async function materializeDirectory(
  basin: Basin,
  source: Reference,
): Promise<Directory> {
  const r = await sourceRef(basin, source);
  validateNode(r, DIRECTORY);
  const entries: Record<string, Directory | File> = Object.create(null);
  for await (const [name, v] of new Trie(
    basin,
    r.get("6").get(2),
    directoryEntries,
  ).entries()) {
    const n = new TextDecoder("utf-8", { fatal: true }).decode(name);
    if (v[0]) {
      const childSource = v[2];
      const childRef = Array.isArray(childSource)
        ? await basin.load(childSource)
        : nodeView(nodeBytes(childSource));
      entries[n] = await materializeDirectory(basin, childRef);
      check(equal(entries[n][1], v[1]), "directory digest mismatch");
    } else entries[n] = v;
  }
  return [true, object<Uint8Array>(r.get("5").get("sha384")), entries];
}
export type BlockRoot = { edge: Edge; digest: Uint8Array };
export async function buildBlock(
  basin: Basin,
  input: Iterable<[bigint, Uint8Array]>,
): Promise<BlockRoot> {
  const pages: [Uint8Array, [Uint8Array]][] = [];
  for (const [page, data] of input) {
    check(page >= 0n, "negative page");
    pages.push([utf8(lex(page)), [data]]);
  }
  const t = await Trie.buildNode(basin, pages, sectors);
  const leaves: [bigint, number, Link][] = [];
  async function collect(n: Node, base: Uint8Array): Promise<void> {
    const h = n[5] as Header,
      here = concat([base, h.prefix ?? new Uint8Array()]),
      m = n[6][3] as unknown[] | null;
    if (m)
      for (let a = 0; a < m.length; a++) {
        const member = m[a];
        if (!Array.isArray(member)) continue;
        for (let b = 0; b < member.length; b++) {
          const child = member[b] as Node | Edge | null;
          if (!child) continue;
          const p = concat([here, new Uint8Array([(a << 4) | b])]);
          if (Array.isArray(child)) {
            const ch = child[5] as Header;
            if (child[3].degree === 0 && ch.keys) {
              const low = unlex(
                  new TextDecoder().decode(concat([p, ch.keys[0]])),
                ),
                high =
                  unlex(new TextDecoder().decode(concat([p, ch.keys[1]]))) + 1n;
              check(low >= 0n && high > low, "invalid leaf page bounds");
              if (high - low <= 0xffffffffn)
                leaves.push([low, Number(high - low), link(child)]);
            } else await collect(object<Node>(await basin.load(child)), p);
          } else await collect(child, p);
        }
      }
  }
  await collect(t.node, new Uint8Array());
  leaves.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const shortcuts = await Vector.buildNode(basin, leaves, leafShortcuts, {
    bits: 7,
  });
  const packed = await pack(basin, [t, shortcuts], 0, []);
  const { leading, lagging } = await vectorBoundaryLinks(
    basin,
    packed.slots[1],
  );
  const edges = packed.edges,
    pagesRoot = packed.slots[0];
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
    6: [0, null, pagesRoot, packed.slots[1], leading, lagging],
  } as Node;
  return {
    edge: await basin.seal(node, edges),
    digest: t.node[6][1].brombergSL2,
  };
}
async function pageRoot(basin: Basin, footer: Reference): Promise<Reference> {
  const pages = footer.get(2);
  return pages.isMap() ? pages : basin.load(edgeFrom(pages));
}
export type VolumeTransferOptions = { replace?: boolean };
export type VolumeRemoveOptions = { recursive?: boolean };
type DirectoryEntry = Directory | File;
function entryAt(root: Directory, parts: readonly string[]): DirectoryEntry {
  let current: DirectoryEntry = root;
  for (const part of parts) {
    check(current[0], "parent is not a directory");
    check(Object.hasOwn(current[2], part), "missing pathname");
    current = current[2][part];
  }
  return current;
}
async function changeEntry(
  root: Directory,
  parts: readonly string[],
  value?: DirectoryEntry,
): Promise<Directory> {
  const contents = Object.assign(Object.create(null), root[2]),
    name = parts[0];
  if (parts.length === 1) {
    if (value) contents[name] = value;
    else delete contents[name];
  } else {
    const child = entryAt(root, [name]);
    check(child[0], "parent is not a directory");
    contents[name] = await changeEntry(child, parts.slice(1), value);
  }
  return directory(contents);
}
async function sealVolume(
  basin: Basin,
  device: { node: Node; edges: Edge[] },
  root: Directory,
): Promise<Volume> {
  const dir = await buildDirectory(basin, root),
    max = basin.options.maxDegree ?? 320;
  let deviceSource: Node | Edge = device.node,
    dirSource: Node | Edge = dir.node,
    edges = distinct([...device.edges, ...dir.edges]);
  if (
    (device.node[5] as Header).inlined + (dir.node[5] as any).inlined > 1280 ||
    edges.length > max
  ) {
    dirSource = await basin.seal(dir.node, dir.edges);
    edges = distinct([...device.edges, dirSource]);
    if ((device.node[5] as Header).inlined > 1280 || edges.length > max) {
      deviceSource = await basin.seal(device.node, device.edges);
      edges = distinct([deviceSource, dirSource]);
    }
  }
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
    6: [0, null, deviceSource, dirSource],
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
    const device = await Trie.buildNode(
      basin,
      [...files].map(([p, f]) => [utf8(p), [f.edge]] as [Uint8Array, [Edge]]),
      devices,
    );
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
      dir.set(last, [false, f.digest, link(f.edge)]);
    }
    const finish = async (t: Tree): Promise<Directory> => {
      const entries: Record<string, Directory | File> = Object.create(null);
      for (const [name, item] of t)
        entries[name] = item instanceof Map ? await finish(item) : item;
      return directory(entries);
    };
    return sealVolume(basin, device, await finish(tree));
  }
  private async data(): Promise<Reference> {
    const r = await this.basin.load(this.root);
    validateNode(r, VOLUME);
    check(
      r.get("6").length() === 4 && r.get("6").get(0).intValue() === 0,
      "unsupported volume migration",
    );
    return r.get("6");
  }
  private async directoryEntry(name: string): Promise<{
    entry: Reference;
    directory: boolean;
    device: Reference | Edge;
  }> {
    const f = await this.data();
    let source = f.get(3);
    if (name === "/")
      return { entry: source, directory: true, device: trieSource(f.get(2)) };
    const parts = path(name);
    for (let i = 0; i < parts.length; i++) {
      const trie = new Trie(
        this.basin,
        await directoryContents(this.basin, source),
        directoryEntries,
      );
      const ref = await trie.getView(utf8(parts[i]));
      check(ref, "missing pathname");
      const folder = ref.get(0).boolValue() === true;
      if (i === parts.length - 1)
        return {
          entry: folder ? ref.get(2) : ref,
          directory: folder,
          device: trieSource(f.get(2)),
        };
      check(folder, "parent is not a directory");
      source = ref.get(2);
    }
    throw Error("missing pathname");
  }
  async stat(
    name = "/",
  ): Promise<
    | { kind: "directory"; sha384: Uint8Array }
    | { kind: "file"; brombergSL2: Uint8Array; link: Link }
  > {
    const { entry, directory } = await this.directoryEntry(name);
    if (directory) {
      const h = entry.isMap() ? entry.get("5") : entry.get(5);
      return { kind: "directory", sha384: object<Uint8Array>(h.get("sha384")) };
    }
    const f = object<File>(entry);
    return { kind: "file", brombergSL2: f[1], link: f[2] };
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
  private readyDescriptor(f: Reference, name: string): File | undefined {
    let source = f.get(3);
    const parts = path(name);
    for (let i = 0; i < parts.length; i++) {
      const node = source.isMap() ? source : this.basin.peek(edgeFrom(source));
      if (!node) return;
      validateNode(node, DIRECTORY);
      const op = new Trie(
        this.basin,
        node.get("6").get(2),
        directoryEntries,
      ).getViewOrDefer(utf8(parts[i]));
      if (typeof op === "function" || op === undefined) return;
      const folder = op.get(0).boolValue() === true;
      if (i === parts.length - 1) return folder ? undefined : object<File>(op);
      if (!folder) return;
      source = op.get(2);
    }
  }
  private async openBlock(
    name: string,
    shortcuts: boolean,
  ): Promise<{ footer: Reference; file: File }> {
    const f = await this.data();
    let edge: Edge | undefined, file: File | undefined;
    const ready =
      shortcuts && this.basin.storage.resolve
        ? this.readyDescriptor(f, name)
        : undefined;
    if (ready)
      try {
        const candidate = await this.basin.storage.resolve!(ready[2]);
        if (candidate && capability(link(candidate)) === capability(ready[2])) {
          const block = await this.basin.load(candidate);
          validateNode(block, BLOCK);
          const pages = block.get("6").get(2),
            sum = pages.isMap() ? pages.get("6").get(1) : pages.get(6).get("1");
          if (equal(object<SectorSummary>(sum).brombergSL2, ready[1])) {
            edge = candidate;
            file = ready;
          }
        }
      } catch {
        /* weak metadata is only a hint */
      }
    if (!edge) {
      const found = await new Trie(
        this.basin,
        trieSource(f.get(2)),
        devices,
      ).get(utf8(name));
      check(found, "missing file");
      edge = found[0];
    }
    const block = await this.basin.load(edge);
    validateNode(block, BLOCK);
    const footer = block.get("6");
    check(
      footer.length() === 6 && footer.get(0).intValue() === 0,
      "unsupported block migration",
    );
    const pages = footer.get(2),
      sum = object<SectorSummary>(
        pages.isMap() ? pages.get("6").get(1) : pages.get(6).get("1"),
      );
    file ??= [false, sum.brombergSL2, link(edge)];
    return { footer, file };
  }
  async page(
    name: string,
    index: bigint,
    shortcuts = true,
  ): Promise<Uint8Array | undefined> {
    check(index >= 0n, "negative page");
    const { footer } = await this.openBlock(name, shortcuts);
    const value = await new Trie<[Uint8Array], SectorSummary>(
      this.basin,
      trieSource(footer.get(2)),
      sectors,
    ).get(utf8(lex(index)));
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
      const leavesRoot = footer.get(3);
      let leaves:
        | Vector<[bigint, number, Link], LeafSummary, Edge | Reference>
        | undefined;
      for (let page = first; page <= boundedLast; page++) {
        const full = utf8(lex(page));
        const direct = pages.getOrDefer(full);
        let value: [Uint8Array] | undefined =
          typeof direct === "function" ? undefined : direct;
        if (
          value === undefined &&
          typeof direct === "function" &&
          options.shortcuts !== false &&
          this.basin.storage.resolve
        ) {
          try {
            leaves ??= new Vector<
              [bigint, number, Link],
              LeafSummary,
              Edge | Reference
            >(
              this.basin,
              leavesRoot.isMap() ? leavesRoot : edgeFrom(leavesRoot),
              leafShortcuts,
            );
            check(leaves.bits === 7, "invalid shortcut vector");
            const shortcut = leaves.findLastOrDefer(
              (v) => v[0] <= page,
              (s) => s.pages !== null && s.pages[0] <= page,
            );
            const found = typeof shortcut === "function" ? undefined : shortcut;
            if (found) {
              const record = found[1];
              const [low, span] = record;
              if (page < low + BigInt(span)) {
                try {
                  const capabilityLink = record[2],
                    edge = await this.basin.storage.resolve(capabilityLink);
                  if (
                    edge &&
                    capability(link(edge)) === capability(capabilityLink)
                  ) {
                    const loaded = await this.basin.load(edge);
                    validateNode(loaded, TRIE);
                    const h = object<Header>(loaded.get("5"));
                    if (h.keys) {
                      const minimum = utf8(lex(low)),
                        base = minimum.subarray(
                          0,
                          minimum.length - h.keys[0].length,
                        );
                      if (
                        equal(concat([base, h.keys[0]]), minimum) &&
                        equal(
                          concat([base, h.keys[1]]),
                          utf8(lex(low + BigInt(span) - 1n)),
                        ) &&
                        full.length >= base.length &&
                        equal(full.subarray(0, base.length), base)
                      )
                        value = await new Trie<[Uint8Array], SectorSummary>(
                          this.basin,
                          loaded,
                          sectors,
                        ).get(full.subarray(base.length));
                    }
                  }
                } catch {
                  /* fall back to the retaining trie */
                }
              }
            }
          } catch {
            /* Shortcut-index misses also fall back to the retaining page trie. */
          }
        }
        value ??= await resolveOperation(direct);
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
    let root = await materializeDirectory(this.basin, footer.get(3));
    const source = entryAt(root, a);
    if (from === to) {
      check(move, "cannot copy onto itself");
      return this;
    }
    check(!to.startsWith(from + "/"), "destination is inside source");
    const parent = entryAt(root, b.slice(0, -1));
    check(parent[0], "parent is not a directory");
    const name = b.at(-1)!,
      target = Object.hasOwn(parent[2], name) ? parent[2][name] : undefined;
    if (target) {
      check(options.replace === true, "destination exists");
      check(source[0] === target[0], "file/directory collision");
      check(
        !target[0] || Object.keys(target[2]).length === 0,
        "destination directory is not empty",
      );
    }
    const view = TrieView.from(
      new Trie(this.basin, trieSource(footer.get(2)), devices),
    );
    let result = view;
    if (source[0]) {
      const prefix = utf8(from + "/"),
        subtree = view.subtree(prefix);
      if (move) result = view.deletePrefix(prefix);
      result = await result.graftPrefix(utf8(to + "/"), subtree, "replace");
    } else {
      const block = await view.get(utf8(from));
      check(block, "missing retained block");
      if (move) result = result.delete(utf8(from));
      result = result.set(utf8(to), block);
    }
    if (move) root = await changeEntry(root, a);
    root = await changeEntry(root, b, source);
    return this.saveFilesystem(root, result);
  }
  async rm(name: string, options: VolumeRemoveOptions = {}): Promise<Volume> {
    const parts = path(name),
      footer = await this.data();
    const root = await materializeDirectory(this.basin, footer.get(3)),
      source = entryAt(root, parts);
    check(
      !source[0] ||
        options.recursive === true ||
        Object.keys(source[2]).length === 0,
      "directory is not empty",
    );
    const view = TrieView.from(
      new Trie(this.basin, trieSource(footer.get(2)), devices),
    );
    const result = source[0]
      ? view.deletePrefix(utf8(name + "/"))
      : view.delete(utf8(name));
    return this.saveFilesystem(await changeEntry(root, parts), result);
  }
  private async saveFilesystem(
    root: Directory,
    device: TrieView<[Edge], null>,
  ): Promise<Volume> {
    return sealVolume(this.basin, await device.buildNode(), root);
  }
  async update(
    changes: Iterable<[string, Uint8Array | null]>,
  ): Promise<Volume> {
    const footer = await this.data(),
      root = await materializeDirectory(this.basin, footer.get(3));
    const sums = new Map<string, Uint8Array>(),
      directories: string[] = [];
    const walk = (dir: Directory, prefix: string) => {
      for (const [name, value] of Object.entries(dir[2])) {
        const path = prefix + "/" + name;
        if (value[0]) {
          directories.push(path);
          walk(value, path);
        } else sums.set(path, value[1]);
      }
    };
    walk(root, "");
    const files = new Map<string, BlockRoot>();
    for await (const [k, v] of new Trie(
      this.basin,
      trieSource(footer.get(2)),
      devices,
    ).entries()) {
      const name = new TextDecoder("utf-8", { fatal: true }).decode(k),
        digest = sums.get(name);
      check(digest, "device/directory mismatch");
      files.set(name, { edge: v[0], digest });
      sums.delete(name);
    }
    check(sums.size === 0, "missing retained block");
    for (const [name, bytes] of changes) {
      path(name);
      if (bytes === null) files.delete(name);
      else {
        const pages: [bigint, Uint8Array][] = [];
        for (let i = 0; i < bytes.length; i += PAGE_SIZE)
          pages.push([BigInt(i / PAGE_SIZE), bytes.slice(i, i + PAGE_SIZE)]);
        files.set(name, await buildBlock(this.basin, pages));
      }
    }
    return Volume.fromBlocks(this.basin, files, directories);
  }
}
