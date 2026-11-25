/** Hash-pruned ordered-byte traversal over inline or edged byte tries. */
import { Basin, check, concat, hex, sha384, utf8, object, type Edge } from "./core";
import { Reference } from "../flexbuffer";
import { Trie, type Consumer, type Header } from "./trie";
import { expand, type Piece } from "./trie-export";
import { readPageBytes } from "./page-range";
import type { ByteSequence, SequenceNode } from "./byte-diff";
export function trieSequence<M extends { size: bigint }>(basin: Basin, source: Edge | Reference, consumer: Consumer<[Uint8Array], M>): ByteSequence {
  type P = Piece<[Uint8Array], M>;
  const node = async (p: P): Promise<SequenceNode> => {
    if (p.kind === "row") {
      const bytes = p.value[0];
      return { size: BigInt(bytes.length), identity: `content/${hex(await sha384(concat([utf8("basinsync/byte-chunk/0/"), bytes])))}`, rank: 0, expand: async () => [] };
    }
    return { size: p.summary.size, identity: Array.isArray(p.source) ? `object/${hex(p.source[6].sha384)}` : undefined,
      rank: (p.h.lengths?.[1] ?? 0) + 1, expand: async () => Promise.all((await expand<[Uint8Array], M>(basin, p)).map(node)) };
  };
  const h = Array.isArray(source) ? source[5] as Header : object<Header>(source.get("5"));
  const summary = Array.isArray(source) ? source[6][1] as M : object<M>(source.get("6").get(1));
  check(typeof summary.size === "bigint" && summary.size >= 0n, "invalid byte size");
  const piece: Extract<P, { kind: "node" }> = { kind: "node", source, origin: new Uint8Array(), from: new Uint8Array(), to: new Uint8Array(), h, summary };
  return { root: { size: summary.size, identity: Array.isArray(source) ? `object/${hex(source[6].sha384)}` : undefined,
    rank: (h.lengths?.[1] ?? 0) + 1, expand: async () => (await node(piece)).expand() },
    read: (at, n) => readPageBytes(new Trie(basin, source, consumer), at, n) };
}
