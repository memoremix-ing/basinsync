import assert from "node:assert/strict";
import {GetObjectCommand,HeadObjectCommand,ListObjectsV2Command,DeleteObjectCommand,PutObjectCommand} from "@aws-sdk/client-s3";
import {fixture,eventually} from "./analogue-fixture";
import {commit,epilogueStatus,sha384} from "./client";
import {toObject} from "./flexbuffer";
import {message} from "./envbuf";
import {encode as lex} from "./lexidecimal";
import {fromKey,key as timelineKey} from "./timeline";
import {eventTuples} from "./events";
import { objectKeys } from "./object-keys";
import { committedKeys } from "./listing";
const f=await fixture("kernel-promotion");
type Node={id:string;revision:string;length:number;sha384:string};
type Graph={milestone:string;databases:Record<string,Node>};
const marker=`${objectKeys.basinEpilogue}${lex(-1n)}`,sign=`${objectKeys.basinEpilogue}${lex(0n)}`;
const key=(n:Node,g:string)=>`${objectKeys.kernelHeap}${g}/${n.id}/${n.revision}`;
async function root(bucket:string){const r=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key:marker}));return toObject(message(await r.Body!.transformToByteArray())) as Graph;}
async function exists(bucket:string,key:string){try{return await f.s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));}catch(e){if((e as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return null;throw e;}}
async function sourceMilestone(bucket:string){for(const Key of await committedKeys(f.s3,bucket,objectKeys.timeline)){const r=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key}));if(eventTuples(await r.Body!.transformToByteArray()).some(t=>t[2]==="sts/0/databasin/commitkernel"&&(t[3] as {viewpoint:string}).viewpoint==="0"))return fromKey(Key);}throw Error("missing commitkernel");}
async function uploaded(bucket:string){return eventually(()=>root(bucket),Boolean);}
async function checkGraph(bucket:string,graph:Graph){for(const node of Object.values(graph.databases)){assert.equal(await exists(bucket,key(node,"young")),null);const head=await exists(bucket,key(node,"old"));assert(head);assert.equal(head.ContentLength,node.length);assert.equal(head.Metadata!.sha384,node.sha384);assert(head.Metadata!["basinsync-source-etag"]);const r=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key:key(node,"old")}));assert.equal(sha384(await r.Body!.transformToByteArray()),node.sha384);}}
try{
  // A one-node marking budget keeps the task until both leaves reach old storage.
  {
    const bucket=await f.bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false,copies=0,payloadGets=0;
    const proxy=f.relay(async(request,next)=>{
      const path=new URL(request.url).pathname;
      if(path.includes(`/${objectKeys.kernelHeap}`)&&request.method==="GET")payloadGets++;
      if(path.includes(`/${objectKeys.kernelHeap}old/`)&&request.method==="PUT"){
        copies++;assert.equal(request.headers.get("if-none-match"),"*");assert(request.headers.get("x-amz-copy-source")?.includes(`${objectKeys.kernelHeap}young/`));assert(request.headers.get("x-amz-copy-source-if-match"));assert(request.headers.get("x-amz-meta-sha384"));
        if(!held){held=true;entered.resolve();await release.promise;}
      }
      return next();
    });
    const app=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30",BASINSYNC_MARK_BATCH_SIZE:"1",BASINSYNC_ERASE_CONCURRENCY:"1"},proxy);
    assert.equal((await commit(app.url,"promotion",new Uint8Array([1]),0n)).status,201);await entered.promise;
    const graph=await uploaded(bucket);assert.equal(await exists(bucket,sign),null);
    assert.equal((await commit(app.url,"promotion",new Uint8Array([2]),1n)).status,201,"a blocked COPY must not block foreground preparation");
    release.resolve();const signed=await eventually(()=>exists(bucket,sign),Boolean);assert(signed);
    assert.equal(signed.Metadata!.upstream,String(await sourceMilestone(bucket)));assert.notEqual(signed.Metadata!.upstream,graph.milestone);
    await checkGraph(bucket,graph);assert(copies>=2);assert.equal(payloadGets,0,"promotion must use COPY, with no payload GET fallback");await f.stop(app.process);
    const restored=await f.server(bucket);assert.equal((await epilogueStatus(restored.url,"promotion")).latest!.viewpoint,1n);await f.stop(restored.process);
  }
  // Failed/embedded-error COPYs retain young; ambiguous success is verified by HEAD.
  for(const fault of ["rejected","embedded-error","lost-reply"]){
    const bucket=await f.bucket(),attempt=Promise.withResolvers<void>();let fail=true,copies=0,payloadGets=0,deletes=0;
    const proxy=f.relay(async(request,next)=>{
      const path=new URL(request.url).pathname;
      if(path.includes(`/${objectKeys.kernelHeap}young/`)&&request.method==="DELETE")deletes++;
      if(path.includes(`/${objectKeys.kernelHeap}`)&&request.method==="GET")payloadGets++;
      if(path.includes(`/${objectKeys.kernelHeap}old/`)&&request.method==="PUT"){
        copies++;attempt.resolve();
        if(fail&&fault==="rejected")return new Response("unsupported COPY",{status:501});
        if(fail&&fault==="embedded-error")return new Response("<Error><Code>InternalError</Code></Error>",{status:200});
        const response=await next();if(fail&&fault==="lost-reply"){await response.arrayBuffer();return new Response("lost COPY reply",{status:503});}return response;
      }
      return next();
    });
    const app=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"50"},proxy);
    assert.equal((await commit(app.url,"copy-fault",new Uint8Array([3]),0n)).status,201);await attempt.promise;
    if(fault!=="lost-reply"){
      await Bun.sleep(70);assert.equal(await exists(bucket,sign),null);assert.equal(deletes,0);await f.stop(app.process);
      const graph=await uploaded(bucket);for(const node of Object.values(graph.databases))assert(await exists(bucket,key(node,"young")));
      assert.equal(payloadGets,0);
      const beforeReplica=await f.recover(bucket,"sequential"),beforeCopies=copies;
      const idleReplica=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"3600000"},proxy);await f.stop(idleReplica.process);
      assert.equal(copies,beforeCopies,"an idle replica shutdown must not resume queued promotion");
      assert.equal((await f.recover(bucket,"sequential")).milestone,beforeReplica.milestone,"shutdown must not append promotion frames");
      assert.equal(await exists(bucket,sign),null);
      fail=false;
      const restart=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},proxy);await eventually(()=>exists(bucket,sign),Boolean);await checkGraph(bucket,graph);await f.stop(restart.process);
    }else{await eventually(()=>exists(bucket,sign),Boolean);await checkGraph(bucket,await root(bucket));assert.equal(copies,2);assert.equal(payloadGets,0);await f.stop(app.process);}
  }
  // A failed young DELETE keeps the durable task; an existing destination avoids re-COPY.
  {
    const bucket=await f.bucket(),attempt=Promise.withResolvers<void>();let fail=true,copies=0;
    const proxy=f.relay(async(request,next)=>{
      const path=new URL(request.url).pathname;if(request.method==="PUT"&&path.includes(`/${objectKeys.kernelHeap}old/`))copies++;
      if(fail&&request.method==="DELETE"&&path.includes(`/${objectKeys.kernelHeap}young/`)){attempt.resolve();return new Response("DELETE unavailable",{status:500});}return next();
    });
    const app=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},proxy);assert.equal((await commit(app.url,"delete-fault",new Uint8Array([4]),0n)).status,201);await attempt.promise;assert.equal(await exists(bucket,sign),null);await f.stop(app.process);
    const before=copies;fail=false;const restarted=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},proxy);await eventually(()=>exists(bucket,sign),Boolean);assert.equal(copies,before);await checkGraph(bucket,await root(bucket));await f.stop(restarted.process);
  }
  // Sign confirmation, rather than PUT success, retires the task. No new backup is needed.
  {
    const bucket=await f.bucket(),attempt=Promise.withResolvers<void>();let confirm=false,stored=false,copies=0,signReads=0;
    const proxy=f.relay(async(request,next)=>{
      const path=new URL(request.url).pathname;if(request.method==="PUT"&&path.includes(`/${objectKeys.kernelHeap}old/`))copies++;
      if(path===`/${bucket}/${sign}`){
        if(request.method==="HEAD"){signReads++;if(stored&&!confirm)return new Response(null,{status:500});}
        const response=await next();if(request.method==="PUT"&&response.ok){stored=true;attempt.resolve();await response.arrayBuffer();return new Response("lost sign reply",{status:503});}return response;
      }return next();
    });
    const app=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},proxy);assert.equal((await commit(app.url,"sign-fault",new Uint8Array([5]),0n)).status,201);await attempt.promise;await f.stop(app.process);
    const before=copies;confirm=true;const restarted=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},proxy);await eventually(async()=>signReads,n=>n>1);await Bun.sleep(150);await f.stop(restarted.process);assert.equal(copies,before);
    const remaining=signReads;const settled=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},proxy);await Bun.sleep(120);await f.stop(settled.process);assert.equal(signReads,remaining,"confirmed task removal survives replay");
    const roots=await f.s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:objectKeys.basinEpilogue}));assert.equal(roots.Contents!.filter(o=>o.Key!.startsWith(`${objectKeys.basinEpilogue}0y`)).length,1,"promotion must not recursively schedule backups");
  }
  // Hot roots stay in memory; restart can recover an old pending root after its source event is evicted.
  {
    const bucket=await f.bucket(),reads:string[]=[];let failCopies=true;
    const proxy=f.relay(async(request,next)=>{
      const path=new URL(request.url).pathname;
      if(request.method==="GET")reads.push(path);
      if(failCopies&&request.method==="PUT"&&path.includes(`/${objectKeys.kernelHeap}old/`))return new Response("COPY paused",{status:501});
      return next();
    });
    const app=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"40"},proxy);
    assert.equal((await commit(app.url,"cached-root",new Uint8Array([7]),0n)).status,201);
    const firstGraph=await uploaded(bucket),source=await sourceMilestone(bucket);
    await Bun.sleep(100);
    assert(!reads.includes(`/${bucket}/${marker}`),"fresh root publication and promotion use the memory cache");
    assert(!reads.includes(`/${bucket}/${timelineKey(source)}`),"fresh roots need no source Timeline GET");
    assert.equal((await commit(app.url,"cached-root",new Uint8Array([8]),1n)).status,201);
    const secondMarker=`${objectKeys.basinEpilogue}${lex(~1n)}`,secondSign=`${objectKeys.basinEpilogue}${lex(1n)}`;
    const second=await eventually(()=>f.s3.send(new GetObjectCommand({Bucket:bucket,Key:secondMarker})),Boolean);
    const secondGraph=toObject(message(await second.Body!.transformToByteArray())) as Graph;
    await f.stop(app.process);assert(BigInt(secondGraph.milestone)>=source);
    for(const object of (await f.s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:objectKeys.timeline}))).Contents!)
      if(fromKey(object.Key!)<=BigInt(secondGraph.milestone))await f.s3.send(new DeleteObjectCommand({Bucket:bucket,Key:object.Key!}));
    assert.equal(await exists(bucket,timelineKey(source)),null);
    const stored=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key:marker})),body=await stored.Body!.transformToByteArray(),metadata=stored.Metadata!;
    const damaged=body.slice();damaged[8]^=1;
    await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:marker,Body:damaged,Metadata:metadata}));
    reads.length=0;failCopies=false;
    const restarted=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"40"},proxy);
    await eventually(async()=>reads.includes(`/${bucket}/${marker}`),Boolean);await Bun.sleep(80);
    assert.equal(await exists(bucket,sign),null,"corrupt source bytes must not produce a PromotionSign");
    assert(!reads.includes(`/${bucket}/${timelineKey(source)}`),"a corrupt stored root must fail closed");
    await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:marker,Body:body,Metadata:metadata}));
    await eventually(()=>exists(bucket,sign),Boolean);await eventually(()=>exists(bucket,secondSign),Boolean);
    await checkGraph(bucket,firstGraph);await checkGraph(bucket,secondGraph);await f.stop(restarted.process);
    const settled=await f.server(bucket);assert.equal((await epilogueStatus(settled.url,"cached-root")).latest!.viewpoint,1n);await f.stop(settled.process);
  }
  // Shutdown waits for the active COPY and its durable completion while the handler stays open.
  {
    const bucket=await f.bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
    const proxy=f.relay(async(request,next)=>{if(!held&&request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.kernelHeap}old/`)){held=true;entered.resolve();await release.promise;}return next();});
    const app=await f.server(bucket,{BASINSYNC_BACKUP_INTERVAL_MS:"30"},proxy);assert.equal((await commit(app.url,"copy-drain",new Uint8Array([6]),0n)).status,201);await entered.promise;
    const stopped=f.stop(app.process);await Bun.sleep(60);assert.equal(app.process.exitCode,null);release.resolve();await stopped;assert(await exists(bucket,sign));await checkGraph(bucket,await root(bucket));
  }
  console.log(`put of success: bounded KernelSpace marking, conditional COPY without relaying bytes, verified destinations, DELETE/reply/sign failures, restart, no backup feedback, and shutdown draining; ${f.artifacts}`);
}finally{await f.close();}
