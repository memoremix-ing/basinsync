import { chunkBytes } from "./chunking";
import { trieSequence } from "./trie-sequence";
/** Fixed-size or content-defined byte chunks in a stored byte trie. */
import { Basin, check, concat, utf8 } from "./core";
import { Trie, composableConsumer, type Consumer } from "./trie";
import { TrieView } from "./trie-view";
import { sectors, type SectorSummary } from "./volume";
import { readPageBytes } from "./page-range";
import { encode as lex } from "../lexidecimal";
import { diffBytes, type ByteSequence } from "./byte-diff";
import * as crc from "./crc64nvme";
const key = (n: number) => utf8(lex(BigInt(n + 1)));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
export class TrieBytes {
  constructor(readonly tree: Trie<[Uint8Array], SectorSummary>, readonly pageSize = 16384, readonly tight = false) {}
  get root() { return this.tree.root; }
  get summary() { return this.tree.root[6][1] as SectorSummary; }
  static content(basin: Basin, bytes: Uint8Array) { return TrieBytes.chunks(basin, chunkBytes([bytes]), true); }
  get basin() { return this.tree.basin; }
  get size() { return (this.tree.root[6][1] as SectorSummary).size; }
  static consumer(tight = false): Consumer<[Uint8Array], SectorSummary> {
    return tight ? composableConsumer({ ...sectors, trieInlineCost: ([bytes]) => Math.max(1, Math.min(1280, Math.ceil(bytes.length / 65536 * 1280))) }, { keyIndependent: true }) : sectors;
  }
  static async build(basin: Basin, bytes: Uint8Array, tight = false, pageSize = 16384) {
    return TrieBytes.chunks(basin, Array.from({ length: Math.ceil(bytes.length / pageSize) }, (_, i) => bytes.slice(i * pageSize, (i + 1) * pageSize)), tight, pageSize);
  }
  static async chunks(basin: Basin, chunks: Iterable<Uint8Array>, tight = false, pageSize = 0) {
    return new TrieBytes(await Trie.build(basin, [...chunks].map((bytes, i) => [key(i), [bytes]] as [Uint8Array, [Uint8Array]]), TrieBytes.consumer(tight)), pageSize, tight);
  }
  async read(at: bigint, n: number): Promise<Uint8Array> {
    const bytes = await readPageBytes(this.tree, at, n);
    if (at === 0n && BigInt(n) >= this.size) check(equal(crc.hash(bytes), (this.tree.root[6][1] as SectorSummary).crc64nvme), "trie file checksum mismatch");
    return bytes;
  }
  sequence(): ByteSequence { return trieSequence(this.basin, this.tree.root, this.tree.consumer); }
  insert(at: bigint, bytes: Uint8Array) { return this.splice(at, 0n, bytes); }
  remove(at: bigint, length: bigint) { return this.splice(at, length, new Uint8Array()); }
  diff(next: TrieBytes, window = 65536) { return diffBytes(this.sequence(), next.sequence(), window); }
  async splice(at: bigint, remove: bigint, add: Uint8Array) {
    check(at >= 0n && remove >= 0n && at + remove <= this.size, "invalid trie file splice");
    if (!remove && !add.length) return this;
    if (this.pageSize === 0) {
      const old = await this.read(0n, Number(this.size));
      return TrieBytes.content(this.basin, concat([old.slice(0, Number(at)), new Uint8Array(add), old.slice(Number(at + remove))]));
    }
    const startPage = Number(at / BigInt(this.pageSize)), start = startPage * this.pageSize;
    const sameSize = BigInt(add.length) === remove;
    const end = sameSize ? Math.min(Number(this.size), Math.ceil(Number(at + remove) / this.pageSize) * this.pageSize) : Number(this.size);
    const old = await this.read(BigInt(start), end - start);
    const offset = Number(at) - start, bytes = concat([old.slice(0, offset), new Uint8Array(add), old.slice(offset + Number(remove))]);
    let view = TrieView.from(this.tree);
    const oldCount = Math.ceil(old.length / this.pageSize), count = Math.ceil(bytes.length / this.pageSize);
    for (let i = 0; i < Math.max(oldCount, count); i++) {
      if (i >= count) view = view.delete(key(startPage + i));
      else {
        const value = bytes.slice(i * this.pageSize, (i + 1) * this.pageSize);
        if (!equal(value, old.subarray(i * this.pageSize, (i + 1) * this.pageSize))) view = view.set(key(startPage + i), [value]);
      }
    }
    return new TrieBytes(await view.store(), this.pageSize, this.tight);
  }
}
