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
} from "./core";
import { Trie, Consumer, plain, Header, TRIE } from "./trie";
import { pack } from "./packed";
import { Vector, vectorBoundaryLinks } from "./vector";
import { encode, Reference } from "../flexbuffer";
import { encode as lex, decode as unlex } from "../lexidecimal";
import * as sl2 from "./bromberg";
export const VOLUME = ".sync-volume/",
  BLOCK = ".sync-block/",
  PAGE_SIZE = 4096;
export type Directory = [true, Uint8Array, Record<string, Directory | File>];
export type File = [false, Uint8Array, Link];
export type SectorSummary = { brombergSL2: Uint8Array };
export const sectors: Consumer<[Uint8Array], SectorSummary> = {
  migration: 0,
  empty: { brombergSL2: sl2.bytes(sl2.identity()) },
  entry: (_k, v) => {
    check(
      Array.isArray(v) && v.length === 1 && v[0] instanceof Uint8Array,
      "invalid page",
    );
    return { brombergSL2: sl2.hash(v[0]) };
  },
  combine: (s) => ({ brombergSL2: sl2.combine(s.map((v) => v.brombergSL2)) }),
};
export const devices: Consumer<[Edge], null> = {
  ...plain,
  edges: (v) => {
    check(Array.isArray(v) && v.length === 1, "invalid device value");
    return [v[0]];
  },
};
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
  const shortcuts = await Vector.buildNode(basin, leaves, plain, { bits: 7 });
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
    const root = await finish(tree),
      node = {
        0: Symbol.species,
        1: DOMAIN,
        2: VOLUME,
        3: device.node[3],
        4: 0,
        5: null,
        6: [0, null, device.node, root],
      } as Node;
    return new Volume(basin, await basin.seal(node, device.edges));
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
  async list(name = "/"): Promise<string[]> {
    const root = object<Directory>((await this.data()).get(3));
    let current: Directory | File = root;
    if (name !== "/")
      for (const part of path(name)) {
        check(
          current[0] && Object.hasOwn(current[2], part),
          "missing directory",
        );
        current = current[2][part];
      }
    check(current[0], "not a directory");
    return Object.keys(current[2]).sort((a, b) => compare(utf8(a), utf8(b)));
  }
  private async descriptor(
    name: string,
  ): Promise<{ file: File; device: Reference }> {
    const f = await this.data();
    let node: Directory | File = object<Directory>(f.get(3));
    for (const part of path(name)) {
      check(node[0] && Object.hasOwn(node[2], part), "missing file");
      node = node[2][part];
    }
    check(!node[0], "not a file");
    return { file: node, device: f.get(2) };
  }
  private async openBlock(
    name: string,
    shortcuts: boolean,
  ): Promise<{ footer: Reference; file: File }> {
    const { file, device } = await this.descriptor(name);
    const strong = async () => {
      const found = await new Trie(this.basin, device, devices).get(utf8(name));
      check(found, "missing retained block");
      return found[0];
    };
    let e: Edge | undefined;
    if (shortcuts && this.basin.storage.resolve) {
      try {
        const found = await this.basin.storage.resolve(file[2]);
        if (found && capability(link(found)) === capability(file[2])) {
          const block = await this.basin.load(found);
          validateNode(block, BLOCK);
          const sum = object<SectorSummary>(
            (await pageRoot(this.basin, block.get("6"))).get("6").get(1),
          );
          if (equal(sum.brombergSL2, file[1])) e = found;
        }
      } catch {
        /* A shortcut is a cache; the strong path remains authoritative. */
      }
    }
    if (!e) e = await strong();
    const block = await this.basin.load(e);
    validateNode(block, BLOCK);
    const footer = block.get("6");
    check(
      footer.length() === 6 && footer.get(0).intValue() === 0,
      "unsupported block migration",
    );
    check(
      equal(
        object<SectorSummary>(
          (await pageRoot(this.basin, footer)).get("6").get(1),
        ).brombergSL2,
        file[1],
      ),
      "block summary mismatch",
    );
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
      await pageRoot(this.basin, footer),
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
      await pageRoot(this.basin, footer),
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
      const header = object<Header>(
        (await pageRoot(this.basin, footer)).get("5"),
      );
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
        | Vector<[bigint, number, Link], null, Edge | Reference>
        | undefined;
      for (let page = first; page <= boundedLast; page++) {
        const full = utf8(lex(page));
        let value: [Uint8Array] | undefined;
        if (options.shortcuts !== false && this.basin.storage.resolve) {
          try {
            leaves ??= new Vector<
              [bigint, number, Link],
              null,
              Edge | Reference
            >(
              this.basin,
              leavesRoot.isMap() ? leavesRoot : edgeFrom(leavesRoot),
              plain,
            );
            check(leaves.bits === 7, "invalid shortcut vector");
            let lo = 0n,
              hi = leaves.length;
            while (lo < hi) {
              const mid = (lo + hi) >> 1n,
                record = await leaves.get(mid);
              check(record, "shortcut vector hole");
              if (record[0] <= page) lo = mid + 1n;
              else hi = mid;
            }
            if (lo > 0n) {
              const record = await leaves.get(lo - 1n);
              check(record, "shortcut vector hole");
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
        value ??= await pages.get(full);
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
  async update(
    changes: Iterable<[string, Uint8Array | null]>,
  ): Promise<Volume> {
    const all = new Map<string, Uint8Array>();
    const directories: string[] = [];
    const visit = async (prefix: string) => {
      for (const name of await this.list(prefix)) {
        const p = prefix === "/" ? `/${name}` : `${prefix}/${name}`;
        try {
          await this.list(p);
          directories.push(p);
          await visit(p);
        } catch {
          all.set(p, await this.read(p));
        }
      }
    };
    await visit("/");
    for (const [name, bytes] of changes) {
      path(name);
      if (bytes === null) all.delete(name);
      else all.set(name, bytes);
    }
    return Volume.build(this.basin, all, directories);
  }
}
