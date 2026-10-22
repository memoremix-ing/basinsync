import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { spawn } from "bun";
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, paginateListObjectsV2 } from "@aws-sdk/client-s3";
import { commit, form, latest, sha384, type ViewpointMismatch } from "./client";
import { encode, key } from "./lexidecimal";
import { stress } from "./stress";

const root = resolve(import.meta.dir, "..");
mkdirSync(`${root}/.local`, { recursive: true });
const artifacts = mkdtempSync(`${root}/.local/integration-`);
const processes: ReturnType<typeof spawn>[] = [];
const credentials = { accessKeyId: "basinsync-test", secretAccessKey: "basinsync-test-secret" };
async function timeout<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline exceeded")), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((yes, no) => { socket.once("error", no); socket.listen(0, "127.0.0.1", yes); });
  const address = socket.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((yes, no) => socket.close(e => e ? no(e) : yes()));
  return address.port;
}

function launch(command: string[], name: string, env: Record<string, string>) {
  const log = openSync(`${artifacts}/${name}.log`, "w");
  const process = spawn(command, { cwd: root, env: { ...Bun.env, ...env }, stdout: log, stderr: log });
  closeSync(log);
  processes.push(process);
  return process;
}

async function stop(process: ReturnType<typeof spawn>) {
  if (process.exitCode !== null) return;
  process.kill("SIGINT");
  try { await timeout(process.exited, 6000); }
  catch { process.kill("SIGKILL"); await process.exited; }
}

async function ready(process: ReturnType<typeof spawn>, probe: () => Promise<unknown>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(process.exitCode, null, `process exited; logs: ${artifacts}`);
    try { await probe(); return; } catch { await Bun.sleep(25); }
  }
  throw new Error(`readiness deadline exceeded; logs: ${artifacts}`);
}

const endpoint = `http://127.0.0.1:${await freePort()}`;
const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials, maxAttempts: 1 });
let serial = 0;
async function bucket() {
  const name = `basinsync-test-${serial++}`;
  await s3.send(new CreateBucketCommand({ Bucket: name }));
  return name;
}
async function server(bucket: string, s3Endpoint = endpoint) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const process = launch([`${root}/target/debug/basinsync`], `server-${serial++}`, {
    S3_ENDPOINT: s3Endpoint, S3_BUCKET: bucket, AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: "", BASINSYNC_LISTEN: `127.0.0.1:${port}`,
  });
  await ready(process, () => latest(url));
  return { process, url };
}
const bytes = (text: string) => new TextEncoder().encode(text);
async function expectStatus(response: Response, status: number) { assert.equal(response.status, status, await response.text()); }
async function expectMismatch(response: Response, expected: bigint, head: bigint | null, blob?: Uint8Array) {
  assert.equal(response.status, 409, "viewpoint mismatch must reject the commit");
  const error = await response.json() as ViewpointMismatch;
  assert.deepEqual(Object.keys(error).sort(), ["latest", "next"]);
  assert.deepEqual(error.next, { viewpoint: expected.toString() });
  if (head === null) {
    assert.equal(error.latest, null, "empty Epilogue has no marker to presign");
  } else {
    assert(error.latest);
    assert.deepEqual(Object.keys(error.latest), ["url"]);
    const url = new URL(error.latest.url);
    assert(url.pathname.endsWith(`/${key(head)}`));
    assert(url.searchParams.has("X-Amz-Signature"));
    const download = await fetch(error.latest.url);
    assert.equal(download.status, 200);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), blob);
  }
}

async function stored(bucket: string, viewpoint: bigint) {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key(viewpoint) }));
  assert(object.Body);
  return object.Body.transformToByteArray();
}

try {
  const fs = launch([process.env.FS_BIN ?? `${root}/.local/bin/fs`, "s3", "--addr", new URL(endpoint).host, "--root", `${artifacts}/s3`], "s3", {
    FS_ROOT_ACCESS_KEY: credentials.accessKeyId, FS_ROOT_SECRET_KEY: credentials.secretAccessKey,
  });
  await ready(fs, async () => { await s3.send(new CreateBucketCommand({ Bucket: "readiness" })); });
  const b = await bucket();
  let writer = await server(b);
  assert.equal(await latest(writer.url), null);
  const a = bytes("359");
  assert(sha384(a).startsWith("00"), "digest fixture preserves leading zero bytes");
  await expectMismatch(await commit(writer.url, a, 1n), 0n, null);
  await expectStatus(await commit(writer.url, a, 0n, "0z000"), 422);
  for (const kind of ["missing", "duplicate", "unknown", "decimal", "wrong-digest", "lexidecimal-digest", "uppercase-digest", "prefixed-digest", "short-digest"]) {
    const data = form(a, 0n);
    if (kind === "missing") data.delete("blob");
    if (kind === "duplicate") data.append("viewpoint", "0");
    if (kind === "unknown") data.append("surprise", "value");
    if (kind === "decimal") data.set("viewpoint", "00");
    if (kind === "wrong-digest") data.set("sha384", "ff".repeat(48));
    if (kind === "lexidecimal-digest") data.set("sha384", encode(BigInt(`0x${sha384(a)}`)));
    if (kind === "uppercase-digest") data.set("sha384", sha384(a).toUpperCase());
    if (kind === "prefixed-digest") data.set("sha384", `0x${sha384(a)}`);
    if (kind === "short-digest") data.set("sha384", sha384(a).slice(2));
    const response = await fetch(`${writer.url}/epilogue`, { method: "PUT", body: data });
    await expectStatus(response, kind.endsWith("-digest") ? 422 : 400);
  }
  await expectStatus(await fetch(`${writer.url}/epilogue`, { method: "PUT", body: "not multipart" }), 400);
  await expectStatus(await commit(writer.url, new Uint8Array(8 * 1024 * 1024), 0n), 413);
  assert.equal(await latest(writer.url), null, "invalid requests cannot create markers");
  await expectStatus(await commit(writer.url, a, 0n), 201);
  await expectMismatch(await commit(writer.url, bytes("replacement"), 0n), 1n, 0n, a);
  const head = await latest(writer.url);
  assert(head && head.viewpoint === "0");
  assert(new URL(head.url).searchParams.has("X-Amz-Signature"));
  assert.deepEqual(new Uint8Array(await (await fetch(head.url)).arrayBuffer()), a);
  const tampered = new URL(head.url);
  tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
  assert.equal((await fetch(tampered)).status, 403, "S3 must verify presigned signatures");
  await assert.rejects(s3.send(new PutObjectCommand({ Bucket: b, Key: key(0n), Body: bytes("overwrite"), IfNoneMatch: "*" })),
    (e: any) => e.$metadata?.httpStatusCode === 412);
  assert.deepEqual(await stored(b, 0n), a);
  console.log("put of success: validation, empty state, signed GET, and immutable first writer");

  const accepted = await stress(writer.url, Number(process.env.STRESS_COMMITS ?? 1025), 16);
  accepted.set(0n, a);
  const keys: string[] = [];
  for await (const page of paginateListObjectsV2({ client: s3, pageSize: 137 }, { Bucket: b, Prefix: "epilogue/" })) {
    keys.push(...(page.Contents ?? []).map(o => o.Key!));
  }
  const ordered = [...accepted.keys()].sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  assert.deepEqual(ordered, Array.from({ length: accepted.size }, (_,i) => BigInt(i)), "gapless acknowledged viewpoints");
  assert.deepEqual(keys, ordered.map(key).reverse(), "all stored keys in descending viewpoint order");
  // Verify every winning payload with bounded read concurrency.
  const entries = [...accepted.entries()];
  let read = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (read < entries.length) {
      const [viewpoint, blob] = entries[read++];
      assert.deepEqual(await stored(b, viewpoint), blob);
    }
  }));
  const before = await latest(writer.url);
  assert(before);
  const current = BigInt(before.viewpoint);
  for (const rejected of [0n, current + 2n]) {
    await expectMismatch(await commit(writer.url, bytes("rejected"), rejected), current + 1n, current, accepted.get(current));
  }
  assert.equal((await latest(writer.url))?.viewpoint, before.viewpoint, "mismatches do not advance the cursor");
  await stop(writer.process);
  writer = await server(b);
  assert.equal((await latest(writer.url))?.viewpoint, before?.viewpoint);
  await expectStatus(await commit(writer.url, new Uint8Array(), BigInt(before!.viewpoint) + 1n), 201);
  await stop(writer.process);
  console.log(`put of success: ${keys.length} gapless keys and exact payloads; restart recovered the minimum key`);

  for (let round = 0; round < Number(process.env.RACE_ROUNDS ?? 8); round++) {
    const raceBucket = await bucket();
    const racers = await Promise.all(Array.from({ length: 3 }, () => server(raceBucket)));
    const payloads = racers.map((_,i) => bytes(`round ${round}, contender ${i}`));
    const responses = await Promise.all(racers.map((r,i) => commit(r.url, payloads[i], 0n)));
    assert.equal(responses.filter(r => r.status === 201).length, 1);
    assert.equal(responses.filter(r => r.status === 503).length, 2);
    const winner = responses.findIndex(r => r.status === 201);
    for (let i=0; i<racers.length; i++) {
      if (i === winner) continue;
      assert.equal(await timeout(racers[i].process.exited), 1, "loser must terminate unsuccessfully");
      assert.equal((await responses[i].json() as {error: string}).error, "leadership_lost");
    }
    assert.deepEqual(await stored(raceBucket, 0n), payloads[winner]);
    await expectStatus(await commit(racers[winner].url, bytes("winner continues"), 1n), 201);
    const page = await s3.send(new ListObjectsV2Command({ Bucket: raceBucket, Prefix: "epilogue/" }));
    assert.deepEqual(page.Contents?.map(o => o.Key), [key(1n), key(0n)]);
    await stop(racers[winner].process);
  }
  console.log("put of success: competing servers choose one winner; losers respond and exit; winner continues");

  // Deliberately sparse fixtures exercise recovery without billions of commits.
  const hugeBucket = await bucket();
  const huge = (1n << 1024n) - 1n;
  await s3.send(new PutObjectCommand({ Bucket: hugeBucket, Key: key(huge), Body: a }));
  const bigWriter = await server(hugeBucket);
  assert.equal((await latest(bigWriter.url))?.viewpoint, huge.toString());
  await expectStatus(await commit(bigWriter.url, a, huge + 1n), 201);
  assert.deepEqual(await stored(hugeBucket, huge + 1n), a);
  await stop(bigWriter.process);

  // Relay signed requests unchanged (including Host) to the real S3 service.
  // Hold the first durable PUT response so the HTTP client can disconnect, then
  // lose a second response after S3 has already accepted its marker.
  const faultBucket = await bucket();
  const durable = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const relay = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const isPut = request.method === "PUT";
      const upstream = await fetch(`${endpoint}${url.pathname}${url.search}`, {
        method: request.method, headers: request.headers,
        body: isPut ? await request.arrayBuffer() : undefined,
        redirect: "manual",
      });
      if (!isPut) return upstream;
      assert.equal(upstream.status, 200);
      if (++writes === 1) {
        durable.resolve();
        await release.promise;
        return upstream;
      }
      await upstream.arrayBuffer();
      return new Response("injected lost response after durable PUT", { status: 503 });
    },
  });
  try {
    const faultWriter = await server(faultBucket, `http://127.0.0.1:${relay.port}`);
    const controller = new AbortController();
    const abandoned = fetch(`${faultWriter.url}/epilogue`, {
      method: "PUT", body: form(a, 0n), signal: controller.signal,
    }).then(() => {}, () => {});
    await timeout(durable.promise);
    controller.abort();
    await abandoned;
    release.resolve();
    assert.equal((await latest(faultWriter.url))?.viewpoint, "0");
    await expectStatus(await commit(faultWriter.url, a, 1n), 503);
    assert.equal(await timeout(faultWriter.process.exited), 1);
    assert.equal(writes, 2, "failed conditional PUT must not be retried");
    const recovered = await server(faultBucket);
    assert.equal((await latest(recovered.url))?.viewpoint, "1");
    assert.deepEqual(await stored(faultBucket, 1n), a);
    await expectStatus(await commit(recovered.url, a, 2n), 201);
    await stop(recovered.process);
    console.log("put of success: disconnected client cannot cancel cursor advance; ambiguous PUT stops and recovers on restart");
  } finally { release.resolve(); await relay.stop(true); }

  const corruptBucket = await bucket();
  await s3.send(new PutObjectCommand({ Bucket: corruptBucket, Key: "epilogue/0", Body: a }));
  const corrupt = launch([`${root}/target/debug/basinsync`], "corrupt-startup", {
    S3_ENDPOINT: endpoint, S3_BUCKET: corruptBucket, AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    BASINSYNC_LISTEN: "127.0.0.1:0",
  });
  assert.equal(await timeout(corrupt.exited), 1);
  console.log("put of success: 1024-bit recovery and size-boundary commit; malformed minimum fails startup");
  console.log(`Integration passed. Logs: ${artifacts}`);
} finally {
  await Promise.all(processes.map(stop));
  s3.destroy();
}
