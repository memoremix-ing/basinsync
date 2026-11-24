/** Direct page-trie versus full leaf index and explicit boundary-index shortcuts. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  Basin,
  MemoryStorage,
  type Storage,
  type Edge,
  type Link,
  object,
  utf8,
  equal,
  concat,
  edgeFrom,
  capability,
  link,
  type Node,
} from "./structures/core";
import { Reference } from "./flexbuffer";
import {
  buildBlock,
  sectors,
  leafShortcuts,
  type SectorSummary,
  type LeafSummary,
} from "./structures/volume";
import { Trie, type Header } from "./structures/trie";
import { Vector } from "./structures/vector";
import { encode as lex } from "./lexidecimal";
const seed = new Uint8Array(32).fill(42),
  samples: any[] = [];
for (const [n, payload] of [
  [20000, 1],
  [350000, 1],
  [5000, 4096],
])
  for (const leafIndex of [true, false]) {
    const storage = new MemoryStorage(),
      writer = new Basin(storage, { seed }),
      pages = Array.from(
        { length: n },
        (_, i) =>
          [BigInt(i), new Uint8Array(payload).fill(i & 255)] as [
            bigint,
            Uint8Array,
          ],
      ),
      block = await buildBlock(writer, pages, { leafIndex });
    for (const at of [0, Math.floor(n / 2), n - 1])
      for (const mode of leafIndex
        ? ["direct", "index", "spine"]
        : ["direct"]) {
        let gets = 0,
          bytes = 0,
          resolves = 0;
        const adapter: Storage = {
          put: storage.put.bind(storage),
          get: async (e) => {
            const data = await storage.get(e);
            gets++;
            bytes += data.length;
            return data;
          },
          resolve: async (l) => {
            resolves++;
            return storage.resolve(l);
          },
        };
        const b = new Basin(adapter, { seed }),
          r = await b.load(block.edge),
          f = r.get("6"),
          source = f.get(2),
          full = utf8(lex(BigInt(at)));
        let value: [Uint8Array] | undefined,
          used = mode;
        if (mode !== "direct") {
          let vectorSource: Reference | Edge = f.get(3).isMap()
            ? f.get(3)
            : edgeFrom(f.get(3));
          if (mode === "spine") {
            const hints = object<Array<Link | null>>(
              f.get(at === 0 ? 4 : 5),
            ).filter((h): h is Link => h !== null);
            if ((at === 0 || at === n - 1) && hints.length) {
              const hint = hints[0],
                e = await adapter.resolve!(hint);
              assert(e && capability(link(e)) === capability(hint));
              vectorSource = e;
            } else used = "index-fallback";
          }
          const found = await new Vector<
            [bigint, number, Link],
            LeafSummary,
            Reference | Edge
          >(b, vectorSource, leafShortcuts).findLast(
            (v) => v[0] <= BigInt(at),
            (s) => s.pages !== null && s.pages[0] <= BigInt(at),
          );
          if (found) {
            const [low, span, pointer] = found[1],
              edge = await adapter.resolve!(pointer);
            assert(edge && capability(link(edge)) === capability(pointer));
            const h = edge[5] as Header,
              minimum = utf8(lex(low));
            assert(h.keys);
            const base = minimum.subarray(0, minimum.length - h.keys[0].length);
            assert(
              equal(concat([base, h.keys[0]]), minimum) &&
                equal(
                  concat([base, h.keys[1]]),
                  utf8(lex(low + BigInt(span) - 1n)),
                ),
            );
            if (
              BigInt(at) < low + BigInt(span) &&
              equal(full.subarray(0, base.length), base)
            )
              value = await new Trie<[Uint8Array], SectorSummary>(
                b,
                edge,
                sectors,
              ).get(full.subarray(base.length));
          }
        }
        value ??= await new Trie<[Uint8Array], SectorSummary>(
          b,
          source.isMap() ? source : edgeFrom(source),
          sectors,
        ).get(full);
        assert.deepEqual(value![0], pages[at][1]);
        samples.push({
          n,
          payload,
          leafIndex,
          at,
          mode,
          used,
          gets,
          bytes,
          resolves,
          objects: storage.objects.size,
          storedBytes: [...storage.objects.values()].reduce(
            (n, o) => n + o.bytes.length,
            0,
          ),
          blockBytes: block.edge[6].length,
        });
      }
  }
writeFileSync(
  ".local/block-index.json",
  JSON.stringify(
    {
      runtime: Bun.version,
      method:
        "cold cache per point read; memory storage; one block root plus page navigation, omits common volume lookup; explicit index and spine paths may fetch indexes; resolver zero I/O; production ready-only hints remain unchanged",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log("block index measurements complete");
