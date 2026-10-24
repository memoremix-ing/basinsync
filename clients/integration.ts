import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, readFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { resolve } from "node:path";
import { spawn } from "bun";
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, paginateListObjectsV2, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { encode as flexEncode } from "flatbuffers/js/flexbuffers.js";
import { toObject, encode as extensionEncode } from "./flexbuffer";
import { commit, form, epilogueStatus, sha384, sha384Bytes, type ApiError, type Position, type ViewpointMismatch } from "./client";
import { parse, stringify } from "./json0";
import { key, fromKey } from "./diffuse16";
import { key as epilogueKey } from "./lexidecimal";
import { encodeEvent, markerAt, deltasAt, legacyDeltasAt, entriesAt, encodeWalEvent, type WalDelta, type Marker } from "./events";
import { ingestWal } from "./wal";
import { stress } from "./stress";

const root = resolve(import.meta.dir, "..");
mkdirSync(`${root}/.local`, { recursive: true });
const artifacts = mkdtempSync(`${root}/.local/timeline-`);
const processes: ReturnType<typeof spawn>[] = [];
const processLogs=new Map<ReturnType<typeof spawn>,string>();
const relays: ReturnType<typeof Bun.serve>[] = [];
const credentials = { accessKeyId: "basinsync-test", secretAccessKey: "basinsync-test-secret" };
async function timeout<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline exceeded")), ms);
  })]); } finally { clearTimeout(timer!); }
}
async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((yes,no) => { socket.once("error",no); socket.listen(0,"127.0.0.1",yes); });
  const address = socket.address(); assert(address && typeof address !== "string");
  await new Promise<void>((yes,no) => socket.close(e => e ? no(e) : yes()));
  return address.port;
}
let serial = 0;
function launch(command: string[], env: Record<string,string>) {
  const logPath=`${artifacts}/process-${serial++}.log`;
  const log = openSync(logPath,"w");
  const p = spawn(command,{cwd:root,env:{...Bun.env,...env},stdout:log,stderr:log});
  closeSync(log); processes.push(p);processLogs.set(p,logPath); return p;
}
async function stop(p: ReturnType<typeof spawn>) {
  if (p.exitCode !== null) return;
  p.kill("SIGINT");
  try { await timeout(p.exited,6000); } catch { p.kill("SIGKILL"); await p.exited; }
}
async function ready(p: ReturnType<typeof spawn>, probe: () => Promise<unknown>) {
  const until = Date.now()+60000;
  while(Date.now()<until) {
    assert.equal(p.exitCode,null,`process exited; logs: ${artifacts}`);
    try { await probe(); return; } catch { await Bun.sleep(20); }
  }
  throw new Error(`readiness deadline; logs: ${artifacts}`);
}
const endpoint = `http://127.0.0.1:${await freePort()}`;
const s3 = new S3Client({ endpoint, region:"us-east-1", forcePathStyle:true, credentials, maxAttempts:1 });
async function bucket() {
  const name = `timeline-test-${serial++}`;
  await s3.send(new CreateBucketCommand({ Bucket:name })); return name;
}
function serverProcess(bucket: string, s3Endpoint: string, address: string, options:Record<string,string>={}) {
  return launch([`${root}/target/debug/basinsync`],{
    S3_ENDPOINT:s3Endpoint,S3_BUCKET:bucket,AWS_REGION:"us-east-1",
    AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,
    AWS_SESSION_TOKEN:"",BASINSYNC_LISTEN:address,BASINSYNC_BACKUP_INTERVAL_MS:"0",...options,
  });
}
async function server(bucket: string, s3Endpoint = endpoint, options:Record<string,string>={}) {
  const address = `127.0.0.1:${await freePort()}`;
  const p = serverProcess(bucket,s3Endpoint,address,options); const url = `http://${address}`;
  await ready(p,async () => {
    const r = await fetch(`${url}/ready`); assert.equal(r.status,404); await r.text();
  });
  return {process:p,url,log:processLogs.get(p)!};
}
function relay(after: (request: Request, response: Response) => Promise<Response> | Response,before?: (request:Request)=>Promise<void | Response>) {
  const service = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const url = new URL(request.url);
    const early=await before?.(request);if(early)return early;
    const response = await fetch(`${endpoint}${url.pathname}${url.search}`,{
      method:request.method,headers:request.headers,
      body:["GET","HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect:"manual",
    });
    return after(request,response);
  }});
  relays.push(service);
  return {service,url:`http://127.0.0.1:${service.port}`};
}
async function queued(log:string,flow:string,viewpoint:number){
  const deadline=Date.now()+15000;
  for(;;){
    const text=readFileSync(log,"utf8").replace(/\u001b\[[0-9;]*m/g,"");
    if(text.split("\n").some(line=>line.includes("commit queued") && line.includes(`flow=${flow}`) && line.includes(`viewpoint=${viewpoint}`)))return;
    assert(Date.now()<deadline,`request never queued: ${flow}/${viewpoint}; ${log}`);await Bun.sleep(2);
  }
}
async function batchLogged(log:string,milestone:number,event="batch prepared"){
  const deadline=Date.now()+15000;
  for(;;){
    if(readFileSync(log,"utf8").replace(/\u001b\[[0-9;]*m/g,"").split("\n").some(line=>line.includes(event)&&line.includes(`milestone=${milestone}`)))return;
    assert(Date.now()<deadline,`batch ${milestone} never reached ${event}; ${log}`);await Bun.sleep(2);
  }
}
const bytes = (s: string) => new TextEncoder().encode(s);
async function status(r: Response, expected: number) {
  const body = await r.text();
  assert.equal(r.status,expected,body);
  if (new URL(r.url).pathname.startsWith("/api/v0/")) {
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
    const decoded = parse<ApiError | Position | ViewpointMismatch>(body);
    if (expected === 409) {
      assert("next" in decoded && typeof decoded.next.viewpoint === "bigint");
    } else if (expected >= 400) {
      assert("error" in decoded && typeof decoded.error === "string");
      assert("message" in decoded && typeof decoded.message === "string");
    }
  }
}
async function mismatch(r: Response, next: bigint) {
  assert.equal(r.status,409);
  const body = await r.text();
  assert.deepEqual(JSON.parse(body),{next:{viewpoint:`0x${next.toString(16)}`}});
  assert.deepEqual(parse<ViewpointMismatch>(body),{next:{viewpoint:next}});
}
async function get(bucket: string, milestone: bigint) {
  const r = await s3.send(new GetObjectCommand({Bucket:bucket,Key:key(milestone)}));
  return r.Body!.transformToByteArray();
}
const marker = (blob: Uint8Array, viewpoint="0"): Marker => ({blob,viewpoint,sha384:sha384(blob)});
async function seed(bucket: string, milestone: bigint, payload: Uint8Array) {
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:key(milestone),Body:payload}));
}
async function badStartup(bucket: string) {
  assert.equal(await timeout(serverProcess(bucket,endpoint,"127.0.0.1:0").exited),1);
}

function isBasinPut(request:Request){const path=new URL(request.url).pathname;return request.method==="PUT"&&path.includes("/epilogue/")&&!path.includes("/flows/");}
const flowKey=(flow:string,vp:bigint)=>`flows/0x${Buffer.from(flow).toString("hex")}/${epilogueKey(vp)}`;
async function eventually<T>(read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+15000;let last:unknown;
  while(Date.now()<deadline){try{const value=await read();if(done(value))return value;last=value;}catch(error){last=error;}await Bun.sleep(10);}
  throw new Error(`condition not reached: ${JSON.stringify(last)}; ${artifacts}`);
}
async function basinBackup(bucket:string){
  const list=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:"epilogue/",MaxKeys:1}));
  const key=list.Contents?.[0]?.Key;if(!key)return null;
  const response=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
  return {key,milestone:BigInt(response.Metadata!.milestone),metadata:response.Metadata!,blob:await response.Body!.transformToByteArray()};
}
async function inspectImage(blob:Uint8Array){
  const path=`${artifacts}/inspect-${serial++}.turso`;writeFileSync(path,blob);
  const inspector=spawn([`${root}/target/debug/examples/frame-fixture`,"--inspect",path],{cwd:root,stdout:"pipe",stderr:"inherit"});
  const value=await new Response(inspector.stdout).json() as {milestone:string;flows:Record<string,string>};assert.equal(await inspector.exited,0);return value;
}

try {
  const fs = launch([process.env.FS_BIN ?? `${root}/.local/bin/fs`,"s3","--addr",new URL(endpoint).host,"--root",`${artifacts}/s3`],{
    FS_ROOT_ACCESS_KEY:credentials.accessKeyId,FS_ROOT_SECRET_KEY:credentials.secretAccessKey,
  });
  await ready(fs,async()=>{await s3.send(new CreateBucketCommand({Bucket:"readiness"}));});
  const b = await bucket();
  // Flow Epilogue contents must never become a source of Basin state.
  await s3.send(new PutObjectCommand({Bucket:b,Key:"flows/unrelated/epilogue/0",Body:bytes("legacy, not a Timeline")}));
  const trace: {method:string;url:URL}[] = [];
  const traced = relay((r,response)=>{ trace.push({method:r.method,url:new URL(r.url)}); return response; });
  let writer = await server(b,traced.url);
  const observer = await server(b,traced.url);
  const flowA = "0x雪/first", flowB = "__proto__";
  const a = bytes("359");
  assert(sha384(a).startsWith("00"));
  assert.deepEqual(await epilogueStatus(writer.url,flowA),{latest:null,recent:null});
  await mismatch(await commit(writer.url,flowA,a,1n),0n);
  for (const kind of ["missing-metadata","duplicate-metadata","missing-flow","nul-flow","long-flow","missing-blob","duplicate-blob","unknown-part","legacy-part","unknown-metadata","decimal","number","negative","missing-viewpoint","missing-digest","hex-digest","array-digest","wrong-digest","short-digest","long-digest","malformed-json","duplicate-property","unescaped-flow","invalid-base64"]) {
    const data = form(flowA,a,0n);
    const metadata: Record<string,unknown> = {flow:flowA,viewpoint:0n,sha384:sha384Bytes(a)};
    if(kind==="missing-flow")delete metadata.flow;
    if(kind==="nul-flow")metadata.flow="x\0y";
    if(kind==="long-flow")metadata.flow="x".repeat(600);
    if(kind==="unknown-metadata")metadata.surprise=true;
    if(kind==="decimal")metadata.viewpoint="0";
    if(kind==="number")metadata.viewpoint=0;
    if(kind==="negative")metadata.viewpoint=-1n;
    if(kind==="missing-viewpoint")delete metadata.viewpoint;
    if(kind==="missing-digest")delete metadata.sha384;
    if(kind==="hex-digest")metadata.sha384=sha384(a);
    if(kind==="array-digest")metadata.sha384=Array.from(sha384Bytes(a));
    if(kind==="wrong-digest")metadata.sha384=new Uint8Array(48).fill(255);
    if(kind==="short-digest")metadata.sha384=sha384Bytes(a).slice(1);
    if(kind==="long-digest")metadata.sha384=new Uint8Array([...sha384Bytes(a),0]);
    data.set("metadata",stringify(metadata));
    if(kind==="missing-metadata")data.delete("metadata");
    if(kind==="duplicate-metadata")data.append("metadata",data.get("metadata") as string);
    if(kind==="missing-blob")data.delete("blob");
    if(kind==="duplicate-blob")data.append("blob",new Blob([a]));
    if(kind==="unknown-part")data.append("surprise","value");
    if(kind==="legacy-part")data.append("flow",flowA);
    if(kind==="malformed-json")data.set("metadata","{");
    const wire = JSON.parse(stringify(metadata));
    if(kind==="duplicate-property")data.set("metadata",`{"flow":"f",${stringify(metadata).slice(1)}`);
    if(kind==="unescaped-flow") {wire.flow="0x1";data.set("metadata",JSON.stringify(wire))}
    if(kind==="invalid-base64") {wire.sha384="0*?";data.set("metadata",JSON.stringify(wire))}
    const expected = ["wrong-digest","short-digest","long-digest"].includes(kind)?422:400;
    await status(await fetch(`${writer.url}/api/v0/epilogue`,{method:"PUT",body:data}),expected);
  }
  // JSON0 accepts standard base64 too; multipart part ordering is immaterial.
  const alternate = new FormData();
  alternate.set("blob",new Blob([a]));
  const wire = JSON.parse(stringify({flow:flowA,viewpoint:1n,sha384:sha384Bytes(a)}));
  wire.sha384=`0%${Buffer.from(sha384Bytes(a)).toString("base64")}`;
  alternate.set("metadata",JSON.stringify(wire));
  await mismatch(await fetch(`${writer.url}/api/v0/epilogue`,{method:"PUT",body:alternate}),0n);
  await status(await fetch(`${writer.url}/epilogue`,{method:"PUT",body:form(flowA,a,0n)}),404);
  await status(await fetch(`${writer.url}/epilogue/status?flow=unversioned`),404);
  await status(await fetch(`${writer.url}/api/v0/epilogue/status`),400);
  await status(await fetch(`${writer.url}/api/v0/epilogue/status?flow=${"x".repeat(600)}`),400);
  await status(await fetch(`${writer.url}/api/v0/epilogue`,{method:"PUT"}),400);
  await status(await fetch(`${writer.url}/api/v0/epilogue`,{method:"POST"}),405);
  await status(await fetch(`${writer.url}/api/v0/epilogue/latest?flow=retired`),404);
  await status(await commit(writer.url,flowA,new Uint8Array(8*1024*1024),0n),413);
  const receipts = new Map<string,Map<bigint,Uint8Array>>();
  async function accepted(url: string, flow: string, blob: Uint8Array, v: bigint) {
    const r = await commit(url,flow,blob,v);
    const body = await r.text();
    assert.equal(r.status,201,body);
    assert.deepEqual(parse<Position>(body),{viewpoint:v});
    if(!receipts.has(flow))receipts.set(flow,new Map()); receipts.get(flow)!.set(v,blob);
  }
  await accepted(writer.url,flowA,a,0n);
  await mismatch(await commit(writer.url,flowA,bytes("replacement"),0n),1n);
  assert.deepEqual(await epilogueStatus(observer.url,flowA),{latest:{viewpoint:0n},recent:null},"running observer replays Timeline");
  assert.deepEqual(await epilogueStatus(observer.url,flowB),{latest:null,recent:null});
  await accepted(writer.url,flowB,new Uint8Array([0,255,128]),0n);
  await accepted(observer.url,flowB,new Uint8Array(),1n);
  await accepted(writer.url,flowA,bytes("independent Flow"),1n);
  assert.deepEqual(await epilogueStatus(writer.url,flowB),{latest:{viewpoint:1n},recent:null});
  console.log("put of success: Flow isolation, validation, prototype-safe ids, and live Timeline refresh");

  const flows = ["red","blue","0","constructor"];
  const count = Number(process.env.STRESS_COMMITS ?? 1025);
  await Promise.all(flows.map(async(flow,i)=>{
    const n = Math.floor(count/flows.length)+(i<count%flows.length?1:0);
    if(n>0)receipts.set(flow,await stress(writer.url,flow,n,4));
  }));
  const total = [...receipts.values()].reduce((n,m)=>n+m.size,0);
  const keys:string[]=[];
  for await(const page of paginateListObjectsV2({client:s3,pageSize:137},{Bucket:b,Prefix:"timeline/"})) keys.push(...(page.Contents??[]).map(o=>o.Key!));
  const eventCount=keys.length;
  assert.deepEqual(keys,Array.from({length:eventCount},(_,i)=>key(BigInt(i+1))).sort());
  assert(fromKey(keys[0])<BigInt(eventCount),"lowest key is a seed, not the latest Milestone");
  const replayed=new Map<string,bigint>();
  const events=new Map<number,{payload:Uint8Array;delta:WalDelta;entries:ReturnType<typeof entriesAt>}>();
  let read=1;
  await Promise.all(Array.from({length:16},async()=>{
    while(read<=eventCount){
      const m=read++,payload=await get(b,BigInt(m));
      const delta=deltasAt(payload).turso["default.turso"] as WalDelta;
      assert.equal(delta.version,"0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88");
      assert.equal(delta.physical.format,"sqlite-wal/1");
      assert(delta.logical.header instanceof Uint8Array && delta.logical.header.length===56);
      assert.equal(delta.logical.frames.length,1);assert(delta.logical.frames[0] instanceof Uint8Array);
      assert.equal(delta.logical.base===null,m!==1);
      const entries=entriesAt(payload);assert(entries.length>0 && entries.length<=32);
      for(const {flow,marker} of entries){assert.equal(marker.sha384,sha384(marker.blob));assert.deepEqual(marker.blob,receipts.get(flow)?.get(BigInt(marker.viewpoint)));}
      events.set(m,{payload,delta,entries});
    }
  }));
  let parent:string|null=null;let image:Uint8Array=new Uint8Array();let seen=0;
  for(let m=1;m<=eventCount;m++){
    const {payload,delta,entries}=events.get(m)!;
    assert.equal(delta.physical.base,String(m-1));assert.equal(delta.physical.milestone,String(m));assert.equal(delta.physical.parent,parent);
    if(m===1){assert(delta.logical.base instanceof Uint8Array);image=new Uint8Array(delta.logical.base);assert.equal(delta.physical.base_sha384,sha384(image));}
    else assert.equal(delta.physical.base_sha384,null);
    image=ingestWal(image,delta.physical.segments);
    for(const {flow,marker} of entries){const vp=BigInt(marker.viewpoint);assert.equal(vp,(replayed.get(flow)??-1n)+1n);replayed.set(flow,vp);seen++;}
    parent=sha384(payload);
  }
  assert.equal(seen,total);
  const database=`${artifacts}/typescript-recovered.turso`;writeFileSync(database,image);
  const inspector=spawn([`${root}/target/debug/examples/frame-fixture`,"--inspect",database],{cwd:root,stdout:"pipe",stderr:"inherit"});
  const materialized=await new Response(inspector.stdout).json() as {milestone:string;flows:Record<string,string>};
  assert.equal(await inspector.exited,0);assert.equal(materialized.milestone,String(eventCount));
  assert.deepEqual(materialized.flows,Object.fromEntries([...replayed].map(([flow,vp])=>[flow,String(vp)])));
  const all=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"flows/"}));
  assert.deepEqual(all.Contents?.map(o=>o.Key),["flows/unrelated/epilogue/0"],"background backup is disabled in this pipeline test");
  await stop(writer.process);
  const start=trace.length;
  writer=await server(b,traced.url);
  const startup=trace.slice(start);
  assert.equal(startup.filter(r=>r.method==="GET"&&r.url.searchParams.get("prefix")==="timeline/").length,1);
  assert.equal(startup.filter(r=>r.method==="GET"&&r.url.pathname.includes("/timeline/")).length,eventCount,"replay the entire Timeline");
  for(const [flow,v] of replayed) assert.deepEqual(await epilogueStatus(writer.url,flow),{latest:{viewpoint:v},recent:null});
  assert(trace.some(r=>r.url.searchParams.get("prefix")==="epilogue/"),"read the Basin recovery anchor before writing");
  await accepted(writer.url,flowA,bytes("after recovery"),2n);
  await stop(writer.process);await stop(observer.process);
  console.log(`put of success: ${total} markers across ${eventCount} gapless Milestones; independent TS WAL ingestion, full replay, and minimum-key seed search`);

  for(let round=0;round<Number(process.env.RACE_ROUNDS??8);round++){
    const raceBucket=await bucket(); let armed=false,arrived=0;
    const gate=Promise.withResolvers<void>();
    const proxy=relay(async(r,response)=>{
      if(armed&&r.method==="HEAD"&&new URL(r.url).pathname.endsWith(`/${key(1n)}`)){
        assert.equal(response.status,404);
        if(++arrived===3)gate.resolve(); await timeout(gate.promise);
      }
      return response;
    });
    const racers=await Promise.all(Array.from({length:3},()=>server(raceBucket,proxy.url)));
    armed=true;
    const payloads=racers.map((_,i)=>bytes(`round ${round}, server ${i}`));
    const responses=await Promise.all(racers.map((r,i)=>commit(r.url,"race",payloads[i],0n)));
    armed=false;
    assert.equal(responses.filter(r=>r.status===201).length,1);
    assert.equal(responses.filter(r=>r.status===503).length,2);
    const winner=responses.findIndex(r=>r.status===201);
    for(let i=0;i<racers.length;i++)if(i!==winner)assert.equal(await timeout(racers[i].process.exited),1);
    assert.deepEqual(markerAt(await get(raceBucket,1n),"race").blob,payloads[winner]);
    await status(await commit(racers[winner].url,"race",a,1n),201);
    await stop(racers[winner].process);await proxy.service.stop(true);
  }
  console.log("put of success: real conditional Timeline races choose one winner; losers respond and exit");

  // A real HTTP batch preserves ordered markers, and no success or status
  // escapes while its S3 write is still blocked before storage.
  let modernRoot:Uint8Array|null=null;
  for(const fail of [false,true]){
    const batchBucket=await bucket();const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    let puts=0,active=0,peak=0;
    const proxy=relay(async(request,response)=>{
      if(request.method==="PUT"){
        active--;if(fail){assert.equal(response.status,200);await response.arrayBuffer();return new Response("durable reply lost",{status:503});}
      }
      return response;
    },async request=>{if(request.method==="PUT"){puts++;active++;peak=Math.max(peak,active);entered.resolve();await gate.promise;}});
    const app=await server(batchBucket,proxy.url,{BASINSYNC_BATCH_MAX:"4",BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const flow=`ordered-${fail?"lost":"ok"}`;let completed=0;
    const requests:Promise<Response>[]=[];
    for(let viewpoint=0;viewpoint<4;viewpoint++){
      requests.push(commit(app.url,flow,bytes(`marker-${viewpoint}`),BigInt(viewpoint)).then(r=>{completed++;return r}));
      await queued(app.log,flow,viewpoint);
    }
    await timeout(entered.promise);
    assert.equal(completed,0);
    await assert.rejects(()=>get(batchBucket,1n),"batch is not stored yet");
    requests.push(commit(app.url,flow,bytes("marker-4"),4n).then(r=>{completed++;return r}));
    await queued(app.log,flow,4);
    let statusFinished=false;
    const statusRequest=fetch(`${app.url}/api/v0/epilogue/status?flow=${flow}`).then(r=>{statusFinished=true;return r});
    await Bun.sleep(30);assert.equal(completed,0);assert.equal(statusFinished,false);
    gate.resolve();
    const results=await Promise.all(requests);
    for(let i=0;i<results.length;i++)await status(results[i],fail?503:201);
    assert.equal(peak,1,"Timeline uploads remain ordered");
    const stored=await get(batchBucket,1n),entries=entriesAt(stored);
    assert.deepEqual(entries.map(e=>e.marker.viewpoint),["0","1","2","3"]);
    assert.deepEqual(entries.map(e=>new TextDecoder().decode(e.marker.blob)),["marker-0","marker-1","marker-2","marker-3"]);
    if(fail){
      await status(await statusRequest,503);
      assert.equal(await timeout(app.process.exited),1);assert.equal(puts,1,"queued batch never uploads after failure");
      const restored=await server(batchBucket);
      assert.deepEqual(await epilogueStatus(restored.url,flow),{latest:{viewpoint:3n},recent:null});
      await status(await commit(restored.url,flow,a,4n),201);await stop(restored.process);
    }else{
      assert.equal((await statusRequest).status,200);
      assert.equal(puts,2,"batch count limit splits the fifth request");
      assert.deepEqual(entriesAt(await get(batchBucket,2n)).map(e=>e.marker.viewpoint),["4"]);
      modernRoot=stored;await stop(app.process);
      const restored=await server(batchBucket);
      assert.deepEqual(await epilogueStatus(restored.url,flow),{latest:{viewpoint:4n},recent:null});await stop(restored.process);
    }
    await proxy.service.stop(true);
  }
  // Preparation advances one batch ahead; failed publication discards it.
  for(const fault of ["none","before","after"]){
    const pipelineBucket=await bucket();const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    let puts=0,active=0,peak=0,completed=0;
    const proxy=relay(async(request,response)=>{
      if(request.method==="PUT"){
        active--;if(fault==="after"){assert.equal(response.status,200);await response.arrayBuffer();return new Response("durable reply lost",{status:503});}
      }
      return response;
    },async request=>{if(request.method==="PUT"){
      puts++;active++;peak=Math.max(peak,active);
      if(puts===1){entered.resolve();await gate.promise;}
      if(fault==="before"){active--;return new Response("not stored",{status:503});}
    }});
    const app=await server(pipelineBucket,proxy.url,{BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",RUST_LOG:"basinsync=debug"});
    const flow=`pipeline-${fault}`;
    const requests=[commit(app.url,flow,a,0n).then(r=>{completed++;return r})];
    await timeout(entered.promise);
    requests.push(commit(app.url,flow,a,1n).then(r=>{completed++;return r}));await batchLogged(app.log,2);
    requests.push(commit(app.url,flow,a,2n).then(r=>{completed++;return r}));await queued(app.log,flow,2);
    let statusDone=false;const latest=fetch(`${app.url}/api/v0/epilogue/status?flow=${flow}`).then(value=>{statusDone=true;return value;});
    await Bun.sleep(30);
    assert.equal(puts,1);assert.equal(completed,0);assert.equal(statusDone,false);
    const prepared=readFileSync(app.log,"utf8").split("\n").filter(line=>line.includes("batch prepared"));
    assert.equal(prepared.length,2,"only two batches may prepare ahead of the publication gate");
    await assert.rejects(()=>get(pipelineBucket,2n));
    gate.resolve();
    const results=await Promise.all(requests);
    for(const result of results)await status(result,fault==="none"?201:503);
    assert.equal(peak,1,"only one conditional publication may be active");
    if(fault==="none"){
      assert.deepEqual(parse(await (await latest).text()),{latest:{viewpoint:2n},recent:null});assert.equal(puts,3);
      for(let n=1;n<=3;n++)assert.equal(markerAt(await get(pipelineBucket,BigInt(n)),flow).viewpoint,String(n-1));
      await stop(app.process);
    }else{
      await status(await latest,503);assert.equal(puts,1);assert.equal(await timeout(app.process.exited),1);
      const restored=await server(pipelineBucket);
      assert.deepEqual(await epilogueStatus(restored.url,flow),{latest:fault==="after"?{viewpoint:0n}:null,recent:null});
      await status(await commit(restored.url,flow,a,fault==="after"?1n:0n),201);await stop(restored.process);
    }
    await proxy.service.stop(true);
  }
  for(const fail of [false,true]){
    const mismatchBucket=await bucket();const second=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    let puts=0;
    const proxy=relay(async(request,response)=>{
      if(request.method==="PUT"&&puts===2&&fail){await response.arrayBuffer();return new Response("second reply lost",{status:503});}
      return response;
    },async request=>{if(request.method==="PUT"&&++puts===2){entered.resolve();await second.promise;}});
    const app=await server(mismatchBucket,proxy.url,{BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",RUST_LOG:"basinsync=debug"});
    await status(await commit(app.url,"deferred-mismatch",a,0n),201);
    const next=commit(app.url,"deferred-mismatch",a,1n);await timeout(entered.promise);
    let conflictDone=false;const conflict=commit(app.url,"deferred-mismatch",a,0n).then(r=>{conflictDone=true;return r});
    await batchLogged(app.log,2,"batch rejected");
    let statusDone=false;const latest=fetch(`${app.url}/api/v0/epilogue/status?flow=deferred-mismatch`).then(r=>{statusDone=true;return r});
    await Bun.sleep(30);assert.equal(conflictDone,false);assert.equal(statusDone,false);
    second.resolve();await status(await next,fail?503:201);
    if(fail){await status(await conflict,503);await status(await latest,503);assert.equal(await timeout(app.process.exited),1);}
    else{await mismatch(await conflict,2n);assert.deepEqual(parse(await (await latest).text()),{latest:{viewpoint:1n},recent:null});await stop(app.process);}
    assert.equal(puts,2,"mismatch-only work must not create an event");await proxy.service.stop(true);
  }
  {
    const full=await bucket();const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let puts=0;
    const proxy=relay((_r,response)=>response,async r=>{if(r.method==="PUT"&&++puts===1){entered.resolve();await gate.promise;}});
    const app=await server(full,proxy.url,{BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const first=Array.from({length:32},(_,n)=>commit(app.url,`full-${n}`,a,0n));await timeout(entered.promise);
    const next=Array.from({length:32},(_,n)=>commit(app.url,`full-${n+32}`,a,0n));await batchLogged(app.log,2);
    assert.equal(puts,1);gate.resolve();for(const result of await Promise.all([...first,...next]))await status(result,201);
    assert.equal(entriesAt(await get(full,1n)).length,32);assert.equal(entriesAt(await get(full,2n)).length,32);
    await stop(app.process);await proxy.service.stop(true);
  }
  console.log("put of success: two-batch real-route overlap, one ordered PUT, full-batch admission, durable status/mismatch barriers, and failed-publication recovery");
  // Byte bounds flush a batch before accepting another large request.
  {
    const limited=await bucket();const app=await server(limited,endpoint,{BASINSYNC_BATCH_MAX:"32",BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const large=new Uint8Array(5*1024*1024).fill(123);
    const first=commit(app.url,"large-a",large,0n);await queued(app.log,"large-a",0);
    const second=commit(app.url,"large-b",large,0n);await queued(app.log,"large-b",0);
    await status(await first,201);await status(await second,201);
    assert.equal(entriesAt(await get(limited,1n)).length,1);assert.equal(entriesAt(await get(limited,2n)).length,1);
    await stop(app.process);
  }
  // Slow form bodies consume admission slots, never the worker's status queue.
  {
    const idle=await bucket(),app=await server(idle);const port=Number(new URL(app.url).port);
    const sockets=await Promise.all(Array.from({length:64},()=>new Promise<ReturnType<typeof createConnection>>((yes,no)=>{
      const socket=createConnection({host:"127.0.0.1",port},()=>{socket.write(`PUT /api/v0/epilogue HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: 1024\r\n\r\n`);yes(socket)});socket.once("error",no);
    })));
    try{await Bun.sleep(30);assert.deepEqual(await timeout(epilogueStatus(app.url,"idle"),3000),{latest:null,recent:null})}finally{for(const socket of sockets)socket.destroy()}
    await status(await commit(app.url,"idle",a,0n),201);await stop(app.process);
  }
  // Dropping an HTTP caller after admission does not cancel its owned batch.
  {
    const disconnected=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    const proxy=relay((_r,response)=>response,async r=>{if(r.method==="PUT"){entered.resolve();await gate.promise}});
    const app=await server(disconnected,proxy.url,{BASINSYNC_BATCH_MAX:"1",RUST_LOG:"basinsync=debug"});
    const abort=new AbortController();
    const request=fetch(`${app.url}/api/v0/epilogue`,{method:"PUT",body:form("disconnected",a,0n),signal:abort.signal});
    await queued(app.log,"disconnected",0);await timeout(entered.promise);abort.abort();await assert.rejects(request);gate.resolve();
    assert.deepEqual(await epilogueStatus(app.url,"disconnected"),{latest:{viewpoint:0n},recent:null});
    await status(await commit(app.url,"disconnected",a,1n),201);await stop(app.process);await proxy.service.stop(true);
  }
  assert(modernRoot);
  for(const fault of ["version","format","parent","bootstrap","wal","logical","command-order"]){
    const vector=toObject(modernRoot) as any[];
    const delta=vector.at(-1)[3].turso["default.turso"];
    if(fault==="version")delta.version="incompatible";
    if(fault==="format")delta.physical.format="unknown";
    if(fault==="parent")delta.physical.parent="00".repeat(48);
    if(fault==="bootstrap")delta.physical.base_sha384="00".repeat(48);
    if(fault==="wal")delta.physical.segments[0][56]^=1;
    if(fault==="logical")delta.logical.frames[0][0]^=1;
    if(fault==="command-order")vector.reverse();
    const fixture=await bucket();await seed(fixture,1n,extensionEncode(vector));await badStartup(fixture);
  }
  console.log("put of success: real-route ordered batches, durable status, count/byte bounds, slow bodies, disconnects, queued failure rejection, and WAL startup integrity");

  // Capture real Turso frames, then re-encode their event independently in JS.
  const fixture=await bucket();
  const markers = {[flowA]:marker(a),[flowB]:marker(new Uint8Array())};
  const captured = spawn([`${root}/target/debug/examples/frame-fixture`], {cwd:root, stdin:"pipe", stdout:"pipe", stderr:"inherit"});
  captured.stdin.write(JSON.stringify(markers, (_key, value) => value instanceof Uint8Array ? Array.from(value) : value));
  captured.stdin.end();
  const capturedBytes = new Uint8Array(await new Response(captured.stdout).arrayBuffer());
  assert.equal(await captured.exited, 0);
  const validEvent = encodeEvent(markers, legacyDeltasAt(capturedBytes));
  await seed(fixture,1n,validEvent);
  const restored=await server(fixture);
  assert.deepEqual(await epilogueStatus(restored.url,flowA),{latest:{viewpoint:0n},recent:null});
  assert.deepEqual(await epilogueStatus(restored.url,flowB),{latest:{viewpoint:0n},recent:null});
  await status(await commit(restored.url,flowA,a,1n<<128n),409);
  await status(await commit(restored.url,flowA,a,1n),201);
  await stop(restored.process);
  const invalid: (()=>Promise<string>)[] = [
    ...["physical-byte", "base-hash", "missing-page", "missing-delta", "wrong-state", "logical-byte", "wrong-version", "missing-version"].map(fault=>async()=>{
      const event = toObject(validEvent) as any;
      const body = event[0][3];
      const delta = body.deltas.turso["default.turso"];
      if (fault === "wrong-version") delta.version = "incompatible";
      if (fault === "missing-version") delete delta.version;
      if (fault === "physical-byte") delta.physical.pages[0].data[0] ^= 1;
      if (fault === "base-hash") delta.physical.before = "00".repeat(48);
      if (fault === "missing-page") delta.physical.pages.pop();
      if (fault === "missing-delta") delete body.deltas;
      if (fault === "wrong-state") body.markers[flowA].viewpoint = "1";
      if (fault === "logical-byte") delta.logical.frames[0][0] ^= 1;
      const b = await bucket(); await seed(b, 1n, extensionEncode(event)); return b;
    }),
    async()=>{const b=await bucket();await s3.send(new PutObjectCommand({Bucket:b,Key:"timeline/0",Body:a}));return b},
    async()=>{const b=await bucket();await seed(b,2n,encodeEvent({f:marker(a)}, legacyDeltasAt(capturedBytes)));return b},
    async()=>{const b=await bucket();await seed(b,1n,encodeEvent({f:{...marker(a),sha384:"00".repeat(48)}}, legacyDeltasAt(capturedBytes)));return b},
    async()=>{const b=await bucket();await seed(b,1n,encodeEvent({f:marker(a,"18446744073709551616")}, legacyDeltasAt(capturedBytes)));return b},
    async()=>{const b=await bucket();await seed(b,1n,flexEncode([["wrong","command",{}]]));return b},
    ...["#species", Symbol.for("species"), Symbol.iterator, new TextEncoder().encode("#species"),
      Array.from(new TextEncoder().encode("#species")),
    ].map(tag=>async()=>{
      const b=await bucket();
      await seed(b,1n,extensionEncode([[tag,"sync.memoremix.com","sts/0/databasin/commitflow",{markers:{f:marker(a)}}]]));
      return b;
    }),
  ];
  for(const fixture of invalid)await badStartup(await fixture());

  const uncertain=await bucket();let puts=0;
  const faulty=relay(async(r,response)=>{
    if(r.method==="PUT") {puts++;assert.equal(response.status,200);await response.arrayBuffer();return new Response("lost durable reply",{status:503})}
    return response;
  });
  const failed=await server(uncertain,faulty.url);
  await status(await commit(failed.url,"f",a,0n),503);
  assert.equal(await timeout(failed.process.exited),1);assert.equal(puts,1);
  const recovered=await server(uncertain);
  assert.deepEqual(await epilogueStatus(recovered.url,"f"),{latest:{viewpoint:0n},recent:null});
  await status(await commit(recovered.url,"f",a,1n),201);
  await stop(recovered.process);
  console.log("put of success: JS-to-Rust replay, malformed-event rejection, and ambiguous Timeline PUT recovery without retries");
  // A delayed Basin upload retains an exact old image while primary writes keep succeeding.
  {
    const b=await bucket(), gate=Promise.withResolvers<void>(), entered=Promise.withResolvers<void>();
    const submitted:{milestone:bigint;blob:Uint8Array;metadata:Record<string,string>}[]=[];
    let active=0,peak=0;
    const proxy=relay((request,response)=>{if(isBasinPut(request)){active--;}return response;},async request=>{
      if(!isBasinPut(request))return;
      assert.equal(request.headers.get("if-none-match"),"*");active++;peak=Math.max(peak,active);
      const metadata=Object.fromEntries([...request.headers].filter(([name])=>name.startsWith("x-amz-meta-")).map(([name,value])=>[name.slice(11),value]));
      submitted.push({milestone:BigInt(metadata.milestone),blob:new Uint8Array(await request.clone().arrayBuffer()),metadata});
      if(submitted.length===1){entered.resolve();await gate.promise;}
    });
    const observer=await server(b);
    const app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10",BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0"});
    const flow="0/雪/../";
    await status(await commit(app.url,flow,a,0n),201);await timeout(entered.promise);
    assert.equal((await basinBackup(b)),null,"no backup before its PUT completes");
    const recent=await epilogueStatus(app.url,flow);assert.equal(recent.recent?.viewpoint,0n);
    assert.deepEqual(new Uint8Array(await (await fetch(recent.recent!.url)).arrayBuffer()),a);
    for(let n=0;n<12;n++)await status(await commit(app.url,`growth-${n}-${"x".repeat(140)}`,bytes(`payload-${n}`),0n),201);
    await status(await commit(app.url,flow,bytes("next"),1n),201);
    assert.equal(active,1);assert.equal(submitted.length,1,"coalesce targets while an upload is blocked");
    gate.resolve();
    const checkpoint=await eventually(()=>basinBackup(b),cp=>cp?.milestone===14n);
    assert(checkpoint);assert.equal(peak,1);
    assert.deepEqual(submitted.map(s=>s.milestone),[1n,14n]);
    let image:Uint8Array=new Uint8Array();
    for(let m=1n;m<=14n;m++){
      const payload=await get(b,m),delta=deltasAt(payload).turso["default.turso"] as WalDelta;
      if(m===1n)image=new Uint8Array(delta.logical.base!);
      image=ingestWal(image,delta.physical.segments);
      const saved=submitted.find(s=>s.milestone===m);
      if(saved){assert.deepEqual(saved.blob,image,"snapshot equals independent physical replay at its own prefix");assert.equal(saved.metadata.sha384,sha384(image));assert.equal(saved.metadata["event-sha384"],sha384(payload));}
    }
    const inspected=await inspectImage(checkpoint.blob);
    assert.equal(inspected.milestone,"14");assert.equal(inspected.flows[flow],"1");
    assert.equal(checkpoint.metadata["turso-version"],"0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88");
    assert.equal(checkpoint.key,epilogueKey(1n),"Basin Viewpoints count backups independently of Milestones");
    await stop(app.process);
    // Keep a suffix after the snapshot; restart must never GET the older prefix.
    assert.equal((await epilogueStatus(observer.url,flow)).latest?.viewpoint,1n,"an already running observer adopts the latest backup");
    await status(await commit(observer.url,flow,bytes("suffix"),2n),201);await stop(observer.process);
    const reads:string[]=[];
    const traced=relay((request,response)=>{if(request.method==="GET")reads.push(new URL(request.url).pathname);return response;});
    const restored=await server(b,traced.url);
    assert.deepEqual(reads.filter(path=>path.includes("/timeline/")),[`/${b}/${key(15n)}`]);
    assert.equal((await epilogueStatus(restored.url,flow)).latest?.viewpoint,2n);
    assert.equal((await epilogueStatus(restored.url,flow)).recent?.viewpoint,1n);
    await status(await commit(restored.url,flow,bytes("after restore"),3n),201);await stop(restored.process);
    // The full image is sufficient even when the pre-snapshot Timeline is unavailable.
    const snapshotOnly=await bucket();
    await s3.send(new PutObjectCommand({Bucket:snapshotOnly,Key:checkpoint.key,Body:checkpoint.blob,Metadata:checkpoint.metadata}));
    const anchored=await server(snapshotOnly);assert.equal((await epilogueStatus(anchored.url,flow)).latest?.viewpoint,1n);
    await status(await commit(anchored.url,flow,bytes("new suffix"),2n),201);await stop(anchored.process);
    assert.equal((deltasAt(await get(snapshotOnly,15n)).turso["default.turso"] as WalDelta).physical.parent,checkpoint.metadata["event-sha384"]);
    // Invalid anchors fail closed, including a mismatch between metadata and the database cursor.
    for(const fault of ["checksum","version","cursor","digest","missing"]){
      const invalid=await bucket(),metadata={...checkpoint.metadata},body=new Uint8Array(checkpoint.blob);
      if(fault==="checksum")body[body.length-1]^=1;
      if(fault==="version")metadata["turso-version"]="old";
      if(fault==="cursor")metadata.milestone="13";
      if(fault==="digest")metadata["event-sha384"]="not-a-digest";
      if(fault==="missing")delete metadata.milestone;
      await s3.send(new PutObjectCommand({Bucket:invalid,Key:checkpoint.key,Body:body,Metadata:metadata}));await badStartup(invalid);
    }
  }
  console.log("put of success: pinned full-file backups, nonblocking coalesced uploads, exact TS WAL equivalence, snapshot-plus-suffix recovery, and corrupt-anchor rejection");

  // Flow copies gate Basin backup, while requests and status remain independent.
  for(const fault of ["blocked","lost-flow-reply","lost-backup-reply","conflict"]){
    const b=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    let copies=0,backups=0,lost=false;
    if(fault==="conflict")await s3.send(new PutObjectCommand({Bucket:b,Key:flowKey("copy",0n),Body:bytes("conflict")}));
    const proxy=relay(async(request,response)=>{
      const lose=fault==="lost-flow-reply"&&request.method==="PUT"&&new URL(request.url).pathname.includes("/flows/")||fault==="lost-backup-reply"&&isBasinPut(request);
      if(lose&&!lost){lost=true;await response.arrayBuffer();return new Response("reply lost",{status:503});}return response;
    },async request=>{
      if(isBasinPut(request))backups++;
      if(request.method==="PUT"&&new URL(request.url).pathname.includes("/flows/")){
        copies++;entered.resolve();if(fault==="blocked")await gate.promise;
      }
    });
    const app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10",BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0"});
    await status(await commit(app.url,"copy",a,0n),201);await timeout(entered.promise);
    if(fault==="blocked"){
      assert.equal(backups,0);assert.equal(await basinBackup(b),null);
      assert.equal((await epilogueStatus(app.url,"copy")).recent,null);
      await status(await commit(app.url,"copy",bytes("second"),1n),201);
      app.process.kill("SIGKILL");await app.process.exited;gate.resolve();
      const restarted=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
      await eventually(()=>basinBackup(b),cp=>cp?.milestone===2n);
      assert.equal((await epilogueStatus(restarted.url,"copy")).recent?.viewpoint,1n);await stop(restarted.process);
    }else if(fault==="conflict"){
      await Bun.sleep(80);assert.equal(backups,0);assert.equal(await basinBackup(b),null);
      assert.equal((await epilogueStatus(app.url,"copy")).latest?.viewpoint,0n);await stop(app.process);
    }else{
      const checkpoint=await eventually(()=>basinBackup(b),cp=>cp?.milestone===1n);assert(checkpoint);
      await Bun.sleep(50);assert.equal(checkpoint.key,epilogueKey(0n));assert.equal(copies,1);assert.equal(backups,1);
      await stop(app.process);
    }
  }
  console.log("put of success: Flow-copy ordering, interrupted-copy restart, immutable conflicts, and ambiguous Flow/backup replies");

  // Copy independent Flows concurrently, but never reorder one Flow or cross a Milestone early.
  {
    const b=await bucket(),source=await server(b,endpoint,{BASINSYNC_BATCH_MAX:"16",BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const requests:Promise<Response>[]=[];
    for(let n=0;n<16;n++){
      const flow=n<4?"ordered-copy":`parallel-${n}`,vp=n<4?n:0;
      requests.push(commit(source.url,flow,bytes(String(n)),BigInt(vp)));await queued(source.log,flow,vp);
    }
    for(const response of await Promise.all(requests))await status(response,201);await stop(source.process);
    const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let active=0,peak=0,finished=0,ordered=-1,backups=0;
    const proxy=relay((request,response)=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes("/flows/")){
        active--;finished++;
        for(let n=0;n<4;n++)if(new URL(request.url).pathname.endsWith(`/${flowKey("ordered-copy",BigInt(n))}`)){assert.equal(ordered,n-1);ordered=n;}
      }
      return response;
    },async request=>{
      if(isBasinPut(request)){assert(finished>=16,"all markers precede the first backup");backups++;}
      if(request.method==="PUT"&&new URL(request.url).pathname.includes("/flows/")){
        active++;peak=Math.max(peak,active);if(active===8)entered.resolve();await gate.promise;
      }
    });
    const app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await timeout(entered.promise);
    assert.equal(active,8);assert.equal(backups,0);
    await status(await commit(app.url,"foreground",a,0n),201);
    assert.equal((await epilogueStatus(app.url,"ordered-copy")).recent,null);
    gate.resolve();await eventually(()=>basinBackup(b),cp=>cp?.milestone===2n);
    assert.equal(peak,8);assert.equal(finished,17);assert.equal(ordered,3);await stop(app.process);
  }
  console.log("put of success: bounded independent Flow copies preserve per-Flow order and Milestone barriers without blocking requests");

  // Backup workers race on Basin Viewpoints and adopt the winning immutable snapshot.
  {
    const b=await bucket(),source=await server(b);
    for(let i=0;i<3;i++)await status(await commit(source.url,"race-copy",bytes(String(i)),BigInt(i)),201);
    await stop(source.process);
    const gate=Promise.withResolvers<void>();let arrived=0;
    const proxy=relay((_,response)=>response,async request=>{if(isBasinPut(request)){if(++arrived===2)gate.resolve();await gate.promise;}});
    const apps=await Promise.all([server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"}),server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"})]);
    const checkpoint=await eventually(()=>basinBackup(b),cp=>cp?.milestone===3n);assert(checkpoint);await Bun.sleep(80);
    assert.equal(checkpoint.key,epilogueKey(0n));assert.equal(arrived,2);
    const objects=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"epilogue/"}));assert.equal(objects.KeyCount,1);
    for(const app of apps){assert.equal((await epilogueStatus(app.url,"race-copy")).recent?.viewpoint,2n);await stop(app.process);}
  }
  // Different snapshot targets must remain monotonic whichever worker wins first.
  for(const winner of [1n,2n]){
    const b=await bucket(),source=await server(b);
    await status(await commit(source.url,"monotonic",a,0n),201);await stop(source.process);
    const low=Promise.withResolvers<void>(),high=Promise.withResolvers<void>(),lowEntered=Promise.withResolvers<void>(),highEntered=Promise.withResolvers<void>();
    const proxy=relay((_,response)=>response,async request=>{
      if(!isBasinPut(request))return;
      const m=BigInt(request.headers.get("x-amz-meta-milestone")!);
      if(m===1n){lowEntered.resolve();await low.promise;}else{highEntered.resolve();await high.promise;}
    });
    const lowApp=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await timeout(lowEntered.promise);
    const producer=await server(b);await status(await commit(producer.url,"monotonic",bytes("second"),1n),201);await stop(producer.process);
    const highApp=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await timeout(highEntered.promise);
    (winner===1n?low:high).resolve();await eventually(()=>basinBackup(b),cp=>cp?.milestone===winner);
    (winner===1n?high:low).resolve();
    const checkpoint=await eventually(()=>basinBackup(b),cp=>cp?.milestone===2n);assert(checkpoint);await Bun.sleep(40);
    assert.equal(checkpoint.key,epilogueKey(winner===1n?1n:0n));
    const list=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"epilogue/"}));assert.equal(list.KeyCount,winner===1n?2:1);
    await stop(lowApp.process);await stop(highApp.process);
  }
  console.log("put of success: competing backup workers retain a gapless Basin Epilogue");
  // Full database images cross the multipart threshold without weakening first-writer wins.
  {
    const b=await bucket();
    const fixture=spawn([`${root}/target/debug/examples/frame-fixture`,"--padded"],{cwd:root,stdin:"pipe",stdout:"pipe",stderr:"inherit"});
    fixture.stdin.write(JSON.stringify({large:marker(a)},(_key,value)=>value instanceof Uint8Array?Array.from(value):value));fixture.stdin.end();
    const payload=new Uint8Array(await new Response(fixture.stdout).arrayBuffer());assert.equal(await fixture.exited,0);await seed(b,1n,payload);
    let completed=0;const operations:string[]=[];const proxy=relay((request,response)=>{
      const url=new URL(request.url);
      if(url.pathname.includes("/epilogue/"))operations.push(`${request.method} ${url.pathname}${url.search}`);
      if(request.method==="POST"&&url.pathname.includes("/epilogue/")&&url.searchParams.has("uploadId")){assert.equal(request.headers.get("if-none-match"),"*");completed++;}
      return response;
    });
    const app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const cp=await eventually(()=>basinBackup(b),cp=>cp?.milestone===1n);assert(cp);assert(cp.blob.length>8*1024*1024);await eventually(async()=>completed,n=>n===1);assert.equal(completed,1,JSON.stringify(operations));
    assert.equal(cp.metadata.sha384,sha384(cp.blob));assert.equal((await inspectImage(cp.blob)).flows.large,"0");
    const upload=await s3.send(new CreateMultipartUploadCommand({Bucket:b,Key:cp.key}));
    try{
      const part=await s3.send(new UploadPartCommand({Bucket:b,Key:cp.key,UploadId:upload.UploadId!,PartNumber:1,Body:a}));
      await assert.rejects(()=>s3.send(new CompleteMultipartUploadCommand({Bucket:b,Key:cp.key,UploadId:upload.UploadId!,IfNoneMatch:"*",MultipartUpload:{Parts:[{PartNumber:1,ETag:part.ETag}]}})),(error:unknown)=>(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===412);
    }finally{await s3.send(new AbortMultipartUploadCommand({Bucket:b,Key:cp.key,UploadId:upload.UploadId!}));}
    assert.equal((await basinBackup(b))?.metadata.sha384,cp.metadata.sha384);
    await status(await commit(app.url,"large",bytes("suffix"),1n),201);await stop(app.process);
    const restored=await server(b);assert.equal((await epilogueStatus(restored.url,"large")).latest?.viewpoint,1n);await stop(restored.process);
  }
  console.log("put of success: multipart snapshots preserve metadata, conditional creation, and suffix recovery");
  console.log(`Integration passed. Logs: ${artifacts}`);
} finally {
  await Promise.all(processes.map(stop));
  await Promise.all(relays.map(r=>r.stop(true)));
  s3.destroy();
}
