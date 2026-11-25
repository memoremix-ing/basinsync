import assert from "node:assert/strict";
import {GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, PutObjectCommand} from "@aws-sdk/client-s3";
import {within,fixture,eventually} from "./analogue-fixture";
import {commit,epilogueStatus,sha384} from "./client";
import {toObject} from "./flexbuffer";
import {message} from "./envbuf";
import {fromKey} from "./timeline";
import {deltasAt,eventTuples,entriesAt,type WalDelta} from "./events";
import {ingestWal} from "./wal";
import { objectKeys } from "./object-keys";
import { passed } from "./scenarios";

type Node={id:string;revision:string;length:number;sha384:string};
type Graph={version:string;milestone:string;coordinate:string;crc32c:string;parent:string;databases:Record<string,Node>};
const f=await fixture("kernel-backup");
async function object(bucket:string,key:string){const r=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));return {body:await r.Body!.transformToByteArray(),metadata:r.Metadata!};}
async function latest(bucket:string){const l=await f.s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:objectKeys.basinEpilogue}));const key=l.Contents?.find(o=>o.Size!>=16&&o.Key!.startsWith(`${objectKeys.basinEpilogue}0y`))?.Key;if(!key)return null;const r=await object(bucket,key);return {...r,key,graph:toObject(message(r.body)) as Graph};}
function nodeKey(n:Node,generation="young"){return `${objectKeys.kernelHeap}${generation}/${n.id}/${n.revision}`;}
async function nodeObject(bucket:string,n:Node){for(const generation of ["old","young"]){const key=nodeKey(n,generation);try{return {...await object(bucket,key),key};}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw error;}}throw Error("missing database node");}
try {
  // Export and PUTs run outside preparation; foreground writes pass a paused backup.
  const bucket=await f.bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
  const proxy=f.relay(async(request,next)=>{
    if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.kernelHeap}young/`)&&!held){held=true;entered.resolve();await release.promise;}
    return next();
  });
  const app=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},proxy);
  assert.equal((await commit(app.url,"kernel",new Uint8Array([1,2]),0n)).status,201);
  await within(entered.promise,"entered");
  assert.equal((await commit(app.url,"kernel",new Uint8Array([3,4]),1n)).status,201);
  release.resolve();
  const cp=await eventually(()=>latest(bucket),cp=>!!cp&&BigInt(cp.graph.milestone)>=3n);assert(cp);
  await eventually(async()=>JSON.stringify((await latest(bucket))!.graph),v=>v===JSON.stringify(cp.graph));
  await f.stop(app.process);
  const root=(await latest(bucket))!;
  assert.deepEqual(Object.keys(root.graph.databases).sort(),["default.turso","kernel.turso"]);
  assert.equal(root.metadata.sha384,sha384(message(root.body)));
  // All published groups contain both databases, including reserve-only/commitkernel groups.
  const listed=await f.s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:objectKeys.timeline}));
  const keys=listed.Contents!.map(o=>o.Key!).sort((a,b)=>Number(fromKey(a)-fromKey(b)));
  const images:Record<string,Uint8Array>={};let reserved=false,committed=false;const atSnapshot:Record<string,Uint8Array>={};
  for(const key of keys){const r=await object(bucket,key),deltas=deltasAt(r.body).turso;assert.deepEqual(Object.keys(deltas).sort(),["default.turso","kernel.turso"]);
    for(const [id,raw] of Object.entries(deltas)){const d=raw as WalDelta;images[id]=ingestWal(images[id]??d.logical.base!,d.physical.segments);}
    if(fromKey(key)===BigInt(root.graph.milestone))for(const [id,bytes] of Object.entries(images))atSnapshot[id]=bytes.slice();
    if(entriesAt(r.body).length===0&&eventTuples(r.body).every(t=>t[2]!=="sts/0/databasin/commitkernel"))reserved=true;
    if(eventTuples(r.body).some(t=>t[2]==="sts/0/databasin/commitkernel"))committed=true;
  }
  assert(reserved&&committed);
  for(const [id,node] of Object.entries(root.graph.databases)){const r=await nodeObject(bucket,node);assert.equal(r.body.length,node.length);assert.equal(sha384(r.body),node.sha384);assert.deepEqual(r.body,atSnapshot[id]);}
  const before=await f.recover(bucket,"sequential");
  const damaged=root.graph.databases["kernel.turso"],stored=await nodeObject(bucket,damaged),bad=stored.body.slice();bad[100]^=1;
  await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:stored.key,Body:bad,Metadata:stored.metadata}));
  await assert.rejects(()=>f.recover(bucket,"sequential"),"corrupt companion image must fail the whole recovery");
  await f.s3.send(new DeleteObjectCommand({Bucket:bucket,Key:stored.key}));
  await assert.rejects(()=>f.recover(bucket,"sequential"),"missing companion image must fail the whole recovery");
  await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:stored.key,Body:stored.body,Metadata:stored.metadata}));
  // Evict only the covered prefix, preserving the backup's own reservation/commit suffix.
  for(const key of keys)if(fromKey(key)<=BigInt(root.graph.milestone))await f.s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));
  const after=await f.recover(bucket,"bulk-parallel");assert.equal(after.sha384,before.sha384);assert.equal(after.kernel_sha384,before.kernel_sha384);assert(before.kernel_sha384);assert.equal(after.crc32c,before.crc32c);assert.equal(after.coordinate,before.coordinate);
  const recovered=await f.server(bucket);assert.equal((await epilogueStatus(recovered.url,"kernel")).latest!.viewpoint,1n);assert.equal((await commit(recovered.url,"kernel",new Uint8Array([5]),2n)).status,201);await f.stop(recovered.process);
  // A durable commitkernel survives loss of its root PUT reply and restart.
  const interrupted=await f.bucket();let reject=true;const attempted=Promise.withResolvers<void>();
  const broken=f.relay(async(request,next)=>{
    if(reject&&request.method==="PUT"&&new URL(request.url).pathname.startsWith(`/${interrupted}/${objectKeys.basinEpilogue}`)){attempted.resolve();return new Response("root unavailable",{status:500});}
    return next();
  });
  const first=await f.server(interrupted,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},broken);
  assert.equal((await commit(first.url,"interrupted",new Uint8Array([7]),0n)).status,201);await within(attempted.promise,"attempted");await f.stop(first.process);
  assert.equal(await latest(interrupted),null);
  const pending=await f.recover(interrupted,"sequential");assert(BigInt(pending.milestone)>=3n);
  reject=false;const restarted=await f.server(interrupted,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},broken);
  const repaired=await eventually(()=>latest(interrupted),Boolean);assert(repaired);
  // Shutdown drains uploads started in this window, so the count is settled.
  await Bun.sleep(150);await f.stop(restarted.process);
  assert.equal((await f.s3.send(new ListObjectsV2Command({Bucket:interrupted,Prefix:objectKeys.kernelHeap}))).Contents!.length,2,"bookkeeping must not recursively create backups");
  // Shutdown keeps the internal handler alive while a pinned image PUT is blocked.
  const draining=await f.bucket(),uploadEntered=Promise.withResolvers<void>(),uploadRelease=Promise.withResolvers<void>();let paused=false;
  const blocked=f.relay(async(request,next)=>{if(!paused&&request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.kernelHeap}young/`)){paused=true;uploadEntered.resolve();await uploadRelease.promise;}return next();});
  const closing=await f.server(draining,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},blocked);
  assert.equal((await commit(closing.url,"drain",new Uint8Array([8]),0n)).status,201);await within(uploadEntered.promise,"uploadEntered");
  const stopped=f.stop(closing.process);await Bun.sleep(50);assert.equal(closing.process.exitCode,null);uploadRelease.resolve();await stopped;
  assert(await latest(draining));assert.equal((await f.recover(draining,"sequential")).flows.drain,"0");
  // Independent processes may lose the Timeline race; their published roots stay gapless.
  const racing=await f.bucket(),seed=await f.server(racing);
  assert.equal((await commit(seed.url,"race",new Uint8Array([8]),0n)).status,201);await f.stop(seed.process);
  const competitors=await Promise.all([f.server(racing,{BASINSYNC_BACKUP_INTERVAL_MS:"200"}),f.server(racing,{BASINSYNC_BACKUP_INTERVAL_MS:"200"})]);
  await eventually(()=>latest(racing),Boolean);await Bun.sleep(250);
  const roots=await f.s3.send(new ListObjectsV2Command({Bucket:racing,Prefix:objectKeys.basinEpilogue}));assert.equal(roots.Contents!.filter(o=>o.Key!.startsWith(`${objectKeys.basinEpilogue}0y`)).length,1);
  for(const app of competitors){if(app.process.exitCode===null)await f.stop(app.process);else assert.equal(app.process.exitCode,1);}
  assert.equal((await f.recover(racing,"sequential")).flows.race,"0");
  // Ambiguous root replies are resolved by reading the immutable root back.
  const ambiguous=await f.bucket();let lost=0;
  const lose=f.relay(async(request,next)=>{const response=await next();if(request.method==="PUT"&&new URL(request.url).pathname.startsWith(`/${ambiguous}/${objectKeys.basinEpilogue}0y`)&&response.ok){lost++;await response.arrayBuffer();return new Response("lost reply",{status:503});}return response;});
  const uncertain=await f.server(ambiguous,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},lose);
  assert.equal((await commit(uncertain.url,"uncertain",new Uint8Array([9]),0n)).status,201);await eventually(()=>latest(ambiguous),Boolean);await f.stop(uncertain.process);assert.equal(lost,1);
  assert.equal((await f.recover(ambiguous,"sequential")).flows.uncertain,"0");
  // Image upload failure cannot acknowledge a root; retry leaves foreground writes available.
  const failed=await f.bucket();let fail=true;const failure=Promise.withResolvers<void>();
  const badUpload=f.relay(async(request,next)=>{if(fail&&request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.kernelHeap}young/`)){fail=false;failure.resolve();return new Response("image unavailable",{status:500});}return next();});
  const retry=await f.server(failed,{BASINSYNC_BACKUP_INTERVAL_MS:"60"},badUpload);
  assert.equal((await commit(retry.url,"retry",new Uint8Array([1]),0n)).status,201);await within(failure.promise,"failure");
  assert.equal((await commit(retry.url,"retry",new Uint8Array([2]),1n)).status,201);const tip=(await epilogueStatus(retry.url,"retry")).timelines.basin.milestone;
  await eventually(()=>latest(failed),cp=>!!cp&&BigInt(cp.graph.milestone)>=tip);await f.stop(retry.process);
  // A legacy application fixture supplies a large database, not a second server backup mode.
  const large=await f.bucket(),fixture=Bun.spawn([`${f.root}/target/debug/examples/frame-fixture`,"--padded"],{stdin:"pipe",stdout:"pipe",stderr:"inherit"});
  fixture.stdin.write(JSON.stringify({large:{viewpoint:"0",blob:[1],sha384:sha384(new Uint8Array([1])),context:{},edges:[]}}));fixture.stdin.end();
  const payload=new Uint8Array(await new Response(fixture.stdout).arrayBuffer());assert.equal(await fixture.exited,0);await f.seed(large,[payload]);
  let largePuts=0,posts=0;
  const observing=f.relay(async(request,next)=>{const path=new URL(request.url).pathname;if(path.includes(`/${objectKeys.kernelHeap}young/`)){if(request.method==="POST")posts++;if(request.method==="PUT"&&Number(request.headers.get("content-length"))>8*1024*1024){largePuts++;assert.equal(request.headers.get("if-none-match"),"*");assert(new URL(request.url).searchParams.get("X-Amz-SignedHeaders")?.includes("content-length"));}}return next();});
  const big=await f.server(large,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},observing);
  const largeRoot=await eventually(()=>latest(large),Boolean);assert(largeRoot);assert(largeRoot.graph.databases["default.turso"].length>8*1024*1024);assert.equal(largePuts,1);assert.equal(posts,0);await f.stop(big.process);
  assert.equal((await f.recover(large,"sequential")).flows.large,"0");
  passed("0zg7 backup nodes", `paired KernelSpace backup nodes, durable internal reservations, commitkernel, foreground progress, prefix-only eviction, and interrupted root repair; ${f.artifacts}`);
}finally{await f.close();}
