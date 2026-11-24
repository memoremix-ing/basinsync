import { committedKeys } from "./listing";
import { objectKeys } from "./object-keys";
import assert from "node:assert/strict";
import { fixture, eventually } from "./analogue-fixture";
import {
  Basin,
  utf8,
  hex,
  derive,
  nodeKey,
  link,
  object,
  nodeView,
  validateNode,
  type Link,
  type Node,
  type Edge,
  type Storage,
} from "./structures/core";
import { Vector } from "./structures/vector";
import { BTree } from "./structures/btree";
import { BPlusTree } from "./structures/bplus";
import { Trie } from "./structures/trie";
import { count } from "./structure-fixture";
import { Volume, BLOCK, type Directory, type File } from "./structures/volume";
import { BasinsyncStorage } from "./structures/basinsync";
import { epilogueStatus, latestBlob, reserveHeap, commit } from "./client";
import { parse } from "./json0";
import { GetObjectCommand } from "@aws-sdk/client-s3";
const f = await fixture("structures");
try {
  const bucket = await f.bucket(),
    app = await f.server(bucket, { BASINSYNC_CLEANUP_INTERVAL_MS: "10" });
  let viewpoint = 0n;
  const storage = new BasinsyncStorage({
      url: app.url,
      flow: "structures",
      viewpoint: () => viewpoint,
    }),
    basin = new Basin(storage, { seed: new Uint8Array(32).fill(42) }),
    rows: [Uint8Array, unknown][] = Array.from({ length: 2000 }, (_, i) => [
      new Uint8Array([i >> 8, i & 255]),
      i % 7 === 0 ? null : BigInt(i),
    ]);
  const trie = await Trie.build(basin, rows, count);
  const child = {
    auth: [trie.root[3].height, 0, (await derive(trie.root)).token] as [
      number,
      number,
      Uint8Array,
    ],
    revision: crypto.randomUUID(),
  };
  const rejected = parse<any>(
    await (
      await reserveHeap(app.url, "structures", 0n, [
        {
          auth: [
            trie.root[3].height + 1,
            0,
            crypto.getRandomValues(new Uint8Array(32)),
          ],
          length: 1,
          edges: [child],
        },
      ])
    ).text(),
  );
  assert.equal(rejected.errors[0].code, "child_revision");
  const rejectedCommit = await commit(
    app.url,
    "structures",
    new Uint8Array(),
    0n,
    undefined,
    [child],
  );
  assert.equal(rejectedCommit.status, 422);
  assert.equal(parse<any>(await rejectedCommit.text()).error, "child_revision");
  await storage.publish(trie.root);
  viewpoint++;
  const marker = parse<Edge>(
    new TextDecoder().decode(
      await latestBlob((await epilogueStatus(app.url, "structures")).latest!),
    ),
  );
  assert.equal(hex(marker[6].sha384), hex(trie.root[6].sha384));
  const fresh = new Trie(new Basin(storage), marker, count);
  for (const i of [0, 63, 1000, 1999])
    assert.deepEqual(await fresh.get(rows[i][0]), rows[i][1]);
  const files: [string, Uint8Array][] = [
    ["/docs/a", utf8("retained file")],
    ["/docs/empty", new Uint8Array()],
    ["/file", Uint8Array.from({ length: 16000 }, (_, i) => i & 255)],
  ];
  const volume = await Volume.build(basin, files);
  await storage.publish(volume.root);
  viewpoint++;
  const ordered = await BTree.build(basin, rows, count);
  await storage.publish(ordered.root);
  viewpoint++;
  const indexed = await Vector.build(
    basin,
    rows.map(([, v]) => v),
    count,
  );
  await storage.publish(indexed.root);
  viewpoint++;
  const leavesOnly = await BPlusTree.build(basin, rows, count);
  await storage.publish(leavesOnly.root);
  viewpoint++;
  // Wait for old-generation copies, then open new readers using only the actions.
  await eventually(
    () => committedKeys(f.s3, bucket, `${objectKeys.userHeap}old/`),
    keys => keys.length > 0,
  );
  const rawRead = async (pointer: Link): Promise<Uint8Array> => {
    for (const generation of ["old", "young"] as const) {
      try {
        return await (
          await f.s3.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: await nodeKey(pointer, generation),
              IfMatch: "*",
            }),
          )
        ).Body!.transformToByteArray();
      } catch (error) {
        if (![404, 412].includes((error as any).$metadata?.httpStatusCode))
          throw error;
      }
    }
    throw Error("missing revisioned node");
  };
  // A cold edge reader needs the DAG, tenant storage configuration and signing;
  // no request, allocation lookup, or Flow revision goes through the Basin.
  const direct: Storage = {
    put: async () => {
      throw Error("read-only");
    },
    get: (edge) => rawRead(link(edge)),
  };
  for (const [name, data] of files)
    assert.deepEqual(
      await new Volume(new Basin(direct), volume.root).read(name, {
        shortcuts: false,
      }),
      data,
    );
  assert.deepEqual(
    await new BTree(new Basin(direct), ordered.root, count).get(rows[1999][0]),
    rows[1999][1],
  );
  assert.deepEqual(
    await new Vector(new Basin(direct), indexed.root, count).get(1999n),
    rows[1999][1],
  );
  assert.deepEqual(
    await new BPlusTree(new Basin(direct), leavesOnly.root, count).get(
      rows[1999][0],
    ),
    rows[1999][1],
  );
  const file = await volume.stat("/docs/a");
  assert.equal(file.kind, "file");
  const shortcut = link((file as Extract<typeof file, { kind: "file" }>).edge);
  validateNode(nodeView(await rawRead(shortcut)), BLOCK);
  for (const [name, data] of files)
    assert.deepEqual(
      await new Volume(new Basin(storage), volume.root).read(name),
      data,
    );
  assert.deepEqual(
    await new Volume(new Basin(storage), volume.root).read("/file", {
      start: 4090,
      length: 30,
    }),
    files[2][1].slice(4090, 4120),
  );
  await f.stop(app.process);
  const restarted = await f.server(bucket, {
    BASINSYNC_CLEANUP_INTERVAL_MS: "10",
  });
  assert.equal(
    (await epilogueStatus(restarted.url, "structures")).latest!.viewpoint,
    viewpoint - 1n,
  );
  assert.deepEqual(
    await new BTree(new Basin(storage), ordered.root, count).get(rows[1000][0]),
    rows[1000][1],
  );
  assert.deepEqual(
    await new Vector(new Basin(storage), indexed.root, count).get(1000n),
    rows[1000][1],
  );
  assert.deepEqual(
    await new BPlusTree(new Basin(storage), leavesOnly.root, count).get(
      rows[1000][0],
    ),
    rows[1000][1],
  );
  // Earlier marker graphs survive staging sweeps and promotion while retained.
  assert.deepEqual(
    await new Trie(new Basin(storage), trie.root, count).get(rows[1999][0]),
    rows[1999][1],
  );
  for (const [name, data] of files)
    assert.deepEqual(
      await new Volume(new Basin(storage), volume.root).read(name, {
        shortcuts: false,
      }),
      data,
    );
  console.log(
    `put of success: real Basinsync reservations, transparent strong edges, conditional uploads, graph publication, promotion, old roots, selective reads and restart; ${f.artifacts}`,
  );
} finally {
  await f.close();
}
