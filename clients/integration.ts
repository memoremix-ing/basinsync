import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { resolve } from "node:path";
import { spawn } from "bun";
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, paginateListObjectsV2, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { encode as flexEncode } from "flatbuffers/js/flexbuffers.js";
import { toObject, encode as extensionEncode } from "./flexbuffer";
import { commit, form, epilogueStatus as fullStatus, latestBlob, sha384, sha384Bytes, type ApiError, type CommitResponse, type Timelines, type ViewpointMismatch, reserveHeap, type HeapResponse, type HeapNode } from "./client";
import { parse, stringify } from "./json0";
import { key, fromKey } from "./diffuse16";
import { key as epilogueKey, encode as lex } from "./lexidecimal";
import { encodeEvent, markerAt, deltasAt, legacyDeltasAt, entriesAt, rangesAt, eventTuples, encodeTuples, encodeWalEvent, type WalDelta, type Marker, reservePath } from "./events";
import { ingestWal } from "./wal";
import { all as envelopes, before as previousEnvelope } from "./envbuf";
import { stress } from "./stress";

// Cursor cases below assert positions; full capability
// responses and their byte ranges are exercised separately.
function payload<T extends {timelines:Timelines}>(value:T){
  assert(typeof value.timelines?.watershed?.milestone==="bigint"&&value.timelines.watershed.milestone>=0n,"every API response carries its durable Watershed prefix");
  const {timelines,...body}=value;return body;
}
function positions(value:Awaited<ReturnType<typeof fullStatus>>){return {...payload(value),latest:value.latest?{viewpoint:value.latest.viewpoint}:null};}
async function epilogueStatus(...args:Parameters<typeof fullStatus>){return positions(await fullStatus(...args));}

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
    AWS_SESSION_TOKEN:"",BASINSYNC_LISTEN:address,BASINSYNC_CLEANUP_INTERVAL_MS:"0",BASINSYNC_BACKUP_INTERVAL_MS:"0",BASINSYNC_STATUS_PROBE_MAX_AGE_MS:"0",...options,
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
    const decoded = parse<ApiError | CommitResponse | ViewpointMismatch>(body);
    payload(decoded);
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
  const response=parse<ViewpointMismatch>(body);
  assert.deepEqual(JSON.parse(body),{next:{viewpoint:`0x${next.toString(16)}`},timelines:{watershed:{milestone:`0x${response.timelines.watershed.milestone.toString(16)}`}}});
  assert.deepEqual(payload(response),{next:{viewpoint:next}});
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

function isWatershedPut(request:Request){const path=new URL(request.url).pathname;return request.method==="PUT"&&path.includes("/epilogue/")&&!path.includes("/flows/");}
const flowKey=(flow:string,vp:bigint)=>`flows/0x${Buffer.from(flow).toString("hex")}/${epilogueKey(vp)}`;
async function flowBlob(bucket:string,flow:string,viewpoint:bigint):Promise<Uint8Array|null>{
  try{
    const response=await s3.send(new GetObjectCommand({Bucket:bucket,Key:flowKey(flow,viewpoint)}));
    return await response.Body!.transformToByteArray();
  }catch(error){
    if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return null;
    throw error;
  }
}
async function eventually<T>(read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+15000;let last:unknown;
  while(Date.now()<deadline){try{const value=await read();if(done(value))return value;last=value;}catch(error){last=error;}await Bun.sleep(10);}
  throw new Error(`condition not reached: ${JSON.stringify(last)}; ${artifacts}`);
}
async function watershedBackup(bucket:string){
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
  // Flow Epilogue contents must never become a source of Watershed state.
  await s3.send(new PutObjectCommand({Bucket:b,Key:"flows/unrelated/epilogue/0",Body:bytes("legacy, not a Timeline")}));
  const trace: {method:string;url:URL}[] = [];
  const traced = relay((r,response)=>{ trace.push({method:r.method,url:new URL(r.url)}); return response; });
  let writer = await server(b,traced.url);
  const observer = await server(b,traced.url);
  const flowA = "0x雪/first", flowB = "__proto__";
  const a = bytes("359");
  assert(sha384(a).startsWith("00"));
  assert.deepEqual(await epilogueStatus(writer.url,flowA),{latest:null});
  await mismatch(await commit(writer.url,flowA,a,1n),0n);
  for (const kind of ["missing-details","duplicate-details","missing-flow","nul-flow","long-flow","missing-blob","duplicate-blob","unknown-part","legacy-part","unknown-details","decimal","number","negative","missing-viewpoint","missing-digest","hex-digest","array-digest","wrong-digest","short-digest","long-digest","malformed-json","duplicate-property","unescaped-flow","invalid-base64"]) {
    const data = form(flowA,a,0n);
    const details: Record<string,unknown> = {flow:flowA,viewpoint:0n,sha384:sha384Bytes(a)};
    if(kind==="missing-flow")delete details.flow;
    if(kind==="nul-flow")details.flow="x\0y";
    if(kind==="long-flow")details.flow="x".repeat(600);
    if(kind==="unknown-details")details.surprise=true;
    if(kind==="decimal")details.viewpoint="0";
    if(kind==="number")details.viewpoint=0;
    if(kind==="negative")details.viewpoint=-1n;
    if(kind==="missing-viewpoint")delete details.viewpoint;
    if(kind==="missing-digest")delete details.sha384;
    if(kind==="hex-digest")details.sha384=sha384(a);
    if(kind==="array-digest")details.sha384=Array.from(sha384Bytes(a));
    if(kind==="wrong-digest")details.sha384=new Uint8Array(48).fill(255);
    if(kind==="short-digest")details.sha384=sha384Bytes(a).slice(1);
    if(kind==="long-digest")details.sha384=new Uint8Array([...sha384Bytes(a),0]);
    data.set("details",stringify(details));
    if(kind==="missing-details")data.delete("details");
    if(kind==="duplicate-details")data.append("details",data.get("details") as string);
    if(kind==="missing-blob")data.delete("blob");
    if(kind==="duplicate-blob")data.append("blob",new Blob([a]));
    if(kind==="unknown-part")data.append("surprise","value");
    if(kind==="legacy-part")data.append("flow",flowA);
    if(kind==="malformed-json")data.set("details","{");
    const wire = JSON.parse(stringify(details));
    if(kind==="duplicate-property")data.set("details",`{"flow":"f",${stringify(details).slice(1)}`);
    if(kind==="unescaped-flow") {wire.flow="0x1";data.set("details",JSON.stringify(wire))}
    if(kind==="invalid-base64") {wire.sha384="0*?";data.set("details",JSON.stringify(wire))}
    const expected = ["wrong-digest","short-digest","long-digest"].includes(kind)?422:400;
    await status(await fetch(`${writer.url}/api/v0/epilogue`,{method:"PUT",body:data}),expected);
  }
  // JSON0 accepts standard base64 too; multipart part ordering is immaterial.
  const alternate = new FormData();
  alternate.set("blob",new Blob([a]));
  const wire = JSON.parse(stringify({flow:flowA,viewpoint:1n,sha384:sha384Bytes(a)}));
  wire.sha384=`0%${Buffer.from(sha384Bytes(a)).toString("base64")}`;
  alternate.set("details",JSON.stringify(wire));
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
    assert.deepEqual(payload(parse<CommitResponse>(body)),{viewpoint:v});
    if(!receipts.has(flow))receipts.set(flow,new Map()); receipts.get(flow)!.set(v,blob);
  }
  await accepted(writer.url,flowA,a,0n);
  await mismatch(await commit(writer.url,flowA,bytes("replacement"),0n),1n);
  assert.deepEqual(await epilogueStatus(observer.url,flowA),{latest:{viewpoint:0n}},"running observer replays Timeline");
  assert.deepEqual(await epilogueStatus(observer.url,flowB),{latest:null});
  await accepted(writer.url,flowB,new Uint8Array([0,255,128]),0n);
  await accepted(observer.url,flowB,new Uint8Array(),1n);
  await accepted(writer.url,flowA,bytes("independent Flow"),1n);
  assert.deepEqual(await epilogueStatus(writer.url,flowB),{latest:{viewpoint:1n}});
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
  for(const [flow,v] of replayed) assert.deepEqual(await epilogueStatus(writer.url,flow),{latest:{viewpoint:v}});
  assert(trace.some(r=>r.url.searchParams.get("prefix")==="epilogue/"),"read the Watershed recovery anchor before writing");
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
    for(let i=0;i<results.length;i++){
      const receipt=parse<CommitResponse|ApiError>(await results[i].clone().text());
      assert.equal(receipt.timelines.watershed.milestone,fail?0n:(i<4?1n:2n),"stamp each batch only after its own publication");
      await status(results[i],fail?503:201);
    }
    assert.equal(peak,1,"Timeline uploads remain ordered");
    const stored=await get(batchBucket,1n),entries=entriesAt(stored);
    assert.deepEqual(entries.map(e=>e.marker.viewpoint),["0","1","2","3"]);
    assert.deepEqual(entries.map(e=>new TextDecoder().decode(e.marker.blob)),["marker-0","marker-1","marker-2","marker-3"]);
    if(fail){
      await status(await statusRequest,503);
      assert.equal(await timeout(app.process.exited),1);assert.equal(puts,1,"queued batch never uploads after failure");
      const restored=await server(batchBucket);
      assert.deepEqual(await epilogueStatus(restored.url,flow),{latest:{viewpoint:3n}});
      await status(await commit(restored.url,flow,a,4n),201);await stop(restored.process);
    }else{
      assert.equal((await statusRequest).status,200);
      assert.equal(puts,2,"batch count limit splits the fifth request");
      assert.deepEqual(entriesAt(await get(batchBucket,2n)).map(e=>e.marker.viewpoint),["4"]);
      modernRoot=stored;await stop(app.process);
      const restored=await server(batchBucket);
      assert.deepEqual(await epilogueStatus(restored.url,flow),{latest:{viewpoint:4n}});await stop(restored.process);
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
    for(let i=0;i<results.length;i++){
      const receipt=parse<CommitResponse|ApiError>(await results[i].clone().text());
      assert.equal(receipt.timelines.watershed.milestone,fault==="none"?BigInt(i+1):0n,"never report a speculative or uncertain batch as durable");
      await status(results[i],fault==="none"?201:503);
    }
    assert.equal(peak,1,"only one conditional publication may be active");
    if(fault==="none"){
      assert.deepEqual(positions(parse(await (await latest).text())),{latest:{viewpoint:2n}});assert.equal(puts,3);
      for(let n=1;n<=3;n++)assert.equal(markerAt(await get(pipelineBucket,BigInt(n)),flow).viewpoint,String(n-1));
      await stop(app.process);
    }else{
      await status(await latest,503);assert.equal(puts,1);assert.equal(await timeout(app.process.exited),1);
      const restored=await server(pipelineBucket);
      assert.deepEqual(await epilogueStatus(restored.url,flow),{latest:fault==="after"?{viewpoint:0n}:null});
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
    else{await mismatch(await conflict,2n);assert.deepEqual(positions(parse(await (await latest).text())),{latest:{viewpoint:1n}});await stop(app.process);}
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
    try{await Bun.sleep(30);assert.deepEqual(await timeout(epilogueStatus(app.url,"idle"),3000),{latest:null})}finally{for(const socket of sockets)socket.destroy()}
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
    assert.deepEqual(await epilogueStatus(app.url,"disconnected"),{latest:{viewpoint:0n}});
    await status(await commit(app.url,"disconnected",a,1n),201);await stop(app.process);await proxy.service.stop(true);
  }
  assert(modernRoot);
  for(const fault of ["version","format","parent","bootstrap","wal","logical","command-order"]){
    const vector=eventTuples(modernRoot) as any[];
    const delta=vector.at(-1)[3].turso["default.turso"];
    if(fault==="version")delta.version="incompatible";
    if(fault==="format")delta.physical.format="unknown";
    if(fault==="parent")delta.physical.parent="00".repeat(48);
    if(fault==="bootstrap")delta.physical.base_sha384="00".repeat(48);
    if(fault==="wal")delta.physical.segments[0][56]^=1;
    if(fault==="logical")delta.logical.frames[0][0]^=1;
    if(fault==="command-order")vector.reverse();
    const fixture=await bucket();await seed(fixture,1n,encodeTuples(vector));await badStartup(fixture);
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
  assert.deepEqual(await epilogueStatus(restored.url,flowA),{latest:{viewpoint:0n}});
  assert.deepEqual(await epilogueStatus(restored.url,flowB),{latest:{viewpoint:0n}});
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
  assert.deepEqual(await epilogueStatus(recovered.url,"f"),{latest:{viewpoint:0n}});
  await status(await commit(recovered.url,"f",a,1n),201);
  await stop(recovered.process);
  console.log("put of success: JS-to-Rust replay, malformed-event rejection, and ambiguous Timeline PUT recovery without retries");
  // A delayed Watershed upload retains an exact old image while primary writes keep succeeding.
  {
    const b=await bucket(), gate=Promise.withResolvers<void>(), entered=Promise.withResolvers<void>();
    const submitted:{milestone:bigint;blob:Uint8Array;metadata:Record<string,string>}[]=[];
    let active=0,peak=0;
    const proxy=relay((request,response)=>{if(isWatershedPut(request)){active--;}return response;},async request=>{
      if(!isWatershedPut(request))return;
      assert.equal(request.headers.get("if-none-match"),"*");active++;peak=Math.max(peak,active);
      const metadata=Object.fromEntries([...request.headers].filter(([name])=>name.startsWith("x-amz-meta-")).map(([name,value])=>[name.slice(11),value]));
      submitted.push({milestone:BigInt(metadata.milestone),blob:new Uint8Array(await request.clone().arrayBuffer()),metadata});
      if(submitted.length===1){entered.resolve();await gate.promise;}
    });
    const observer=await server(b);
    const app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10",BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0"});
    const flow="0/雪/../";
    await status(await commit(app.url,flow,a,0n),201);await timeout(entered.promise);
    assert.equal((await watershedBackup(b)),null,"no backup before its PUT completes");
    assert.deepEqual(await flowBlob(b,flow,0n),a);
    assert.deepEqual(await latestBlob((await fullStatus(app.url,flow)).latest!),a);
    for(let n=0;n<12;n++)await status(await commit(app.url,`growth-${n}-${"x".repeat(140)}`,bytes(`payload-${n}`),0n),201);
    await status(await commit(app.url,flow,bytes("next"),1n),201);
    assert.equal(active,1);assert.equal(submitted.length,1,"coalesce targets while an upload is blocked");
    gate.resolve();
    const checkpoint=await eventually(()=>watershedBackup(b),cp=>cp?.milestone===14n);
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
    assert.equal(checkpoint.key,epilogueKey(1n),"Watershed Viewpoints count backups independently of Milestones");
    await stop(app.process);
    // Keep a suffix after the snapshot; restart must never GET the older prefix.
    assert.equal((await epilogueStatus(observer.url,flow)).latest?.viewpoint,1n,"an already running observer adopts the latest backup");
    await status(await commit(observer.url,flow,bytes("suffix"),2n),201);await stop(observer.process);
    const reads:string[]=[];
    const traced=relay((request,response)=>{if(request.method==="GET")reads.push(new URL(request.url).pathname);return response;});
    const restored=await server(b,traced.url);
    assert.deepEqual(reads.filter(path=>path.includes("/timeline/")),[`/${b}/${key(15n)}`]);
    assert.equal((await epilogueStatus(restored.url,flow)).latest?.viewpoint,2n);
    assert.deepEqual(await flowBlob(b,flow,1n),bytes("next"));
    assert.equal(await flowBlob(b,flow,2n),null);
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

  // Flow copies gate Watershed backup, while requests and status remain independent.
  for(const fault of ["blocked","lost-flow-reply","lost-backup-reply","conflict"]){
    const b=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    let copies=0,backups=0,lost=false;
    if(fault==="conflict")await s3.send(new PutObjectCommand({Bucket:b,Key:flowKey("copy",0n),Body:bytes("conflict")}));
    const proxy=relay(async(request,response)=>{
      const lose=fault==="lost-flow-reply"&&request.method==="PUT"&&new URL(request.url).pathname.includes("/flows/")||fault==="lost-backup-reply"&&isWatershedPut(request);
      if(lose&&!lost){lost=true;await response.arrayBuffer();return new Response("reply lost",{status:503});}return response;
    },async request=>{
      if(isWatershedPut(request))backups++;
      if(request.method==="PUT"&&new URL(request.url).pathname.includes("/flows/")){
        copies++;entered.resolve();if(fault==="blocked")await gate.promise;
      }
    });
    const app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10",BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0"});
    await status(await commit(app.url,"copy",a,0n),201);await timeout(entered.promise);
    if(fault==="blocked"){
      assert.equal(backups,0);assert.equal(await watershedBackup(b),null);
      assert.equal(await flowBlob(b,"copy",0n),null);
      await status(await commit(app.url,"copy",bytes("second"),1n),201);
      app.process.kill("SIGKILL");await app.process.exited;gate.resolve();
      const restarted=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
      await eventually(()=>watershedBackup(b),cp=>cp?.milestone===2n);
      assert.deepEqual(await flowBlob(b,"copy",0n),a);
      assert.deepEqual(await flowBlob(b,"copy",1n),bytes("second"));await stop(restarted.process);
    }else if(fault==="conflict"){
      await Bun.sleep(80);assert.equal(backups,0);assert.equal(await watershedBackup(b),null);
      assert.equal((await epilogueStatus(app.url,"copy")).latest?.viewpoint,0n);assert.deepEqual(await latestBlob((await fullStatus(app.url,"copy")).latest!),a,"a conflicting stored marker must not replace latest contents");await stop(app.process);
    }else{
      const checkpoint=await eventually(()=>watershedBackup(b),cp=>cp?.milestone===1n);assert(checkpoint);
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
      if(isWatershedPut(request)){assert(finished>=16,"all markers precede the first backup");backups++;}
      if(request.method==="PUT"&&new URL(request.url).pathname.includes("/flows/")){
        active++;peak=Math.max(peak,active);if(active===8)entered.resolve();await gate.promise;
      }
    });
    const app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await timeout(entered.promise);
    assert.equal(active,8);assert.equal(backups,0);
    await status(await commit(app.url,"foreground",a,0n),201);
    assert.equal(await flowBlob(b,"ordered-copy",0n),null);
    gate.resolve();await eventually(()=>watershedBackup(b),cp=>cp?.milestone===2n);
    assert.equal(peak,8);assert.equal(finished,17);assert.equal(ordered,3);await stop(app.process);
  }
  console.log("put of success: bounded independent Flow copies preserve per-Flow order and Milestone barriers without blocking requests");

  // Backup workers race on Watershed Viewpoints and adopt the winning immutable snapshot.
  {
    const b=await bucket(),source=await server(b);
    for(let i=0;i<3;i++)await status(await commit(source.url,"race-copy",bytes(String(i)),BigInt(i)),201);
    await stop(source.process);
    const gate=Promise.withResolvers<void>();let arrived=0;
    const proxy=relay((_,response)=>response,async request=>{if(isWatershedPut(request)){if(++arrived===2)gate.resolve();await gate.promise;}});
    const apps=await Promise.all([server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"}),server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"})]);
    const checkpoint=await eventually(()=>watershedBackup(b),cp=>cp?.milestone===3n);assert(checkpoint);await Bun.sleep(80);
    assert.equal(checkpoint.key,epilogueKey(0n));assert.equal(arrived,2);
    const objects=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"epilogue/"}));assert.equal(objects.KeyCount,1);
    for(let n=0;n<3;n++)assert.deepEqual(await flowBlob(b,"race-copy",BigInt(n)),bytes(String(n)));
    for(const app of apps){assert.equal((await epilogueStatus(app.url,"race-copy")).latest?.viewpoint,2n);await stop(app.process);}
  }
  // Different snapshot targets must remain monotonic whichever worker wins first.
  for(const winner of [1n,2n]){
    const b=await bucket(),source=await server(b);
    await status(await commit(source.url,"monotonic",a,0n),201);await stop(source.process);
    const low=Promise.withResolvers<void>(),high=Promise.withResolvers<void>(),lowEntered=Promise.withResolvers<void>(),highEntered=Promise.withResolvers<void>();
    const proxy=relay((_,response)=>response,async request=>{
      if(!isWatershedPut(request))return;
      const m=BigInt(request.headers.get("x-amz-meta-milestone")!);
      if(m===1n){lowEntered.resolve();await low.promise;}else{highEntered.resolve();await high.promise;}
    });
    const lowApp=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await timeout(lowEntered.promise);
    const producer=await server(b);await status(await commit(producer.url,"monotonic",bytes("second"),1n),201);await stop(producer.process);
    const highApp=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await timeout(highEntered.promise);
    (winner===1n?low:high).resolve();await eventually(()=>watershedBackup(b),cp=>cp?.milestone===winner);
    (winner===1n?high:low).resolve();
    const checkpoint=await eventually(()=>watershedBackup(b),cp=>cp?.milestone===2n);assert(checkpoint);await Bun.sleep(40);
    assert.equal(checkpoint.key,epilogueKey(winner===1n?1n:0n));
    const list=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"epilogue/"}));assert.equal(list.KeyCount,winner===1n?2:1);
    await stop(lowApp.process);await stop(highApp.process);
  }
  console.log("put of success: competing backup workers retain a gapless Watershed Epilogue");
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
    const cp=await eventually(()=>watershedBackup(b),cp=>cp?.milestone===1n);assert(cp);assert(cp.blob.length>8*1024*1024);await eventually(async()=>completed,n=>n===1);assert.equal(completed,1,JSON.stringify(operations));
    assert.equal(cp.metadata.sha384,sha384(cp.blob));assert.equal((await inspectImage(cp.blob)).flows.large,"0");
    const upload=await s3.send(new CreateMultipartUploadCommand({Bucket:b,Key:cp.key}));
    try{
      const part=await s3.send(new UploadPartCommand({Bucket:b,Key:cp.key,UploadId:upload.UploadId!,PartNumber:1,Body:a}));
      await assert.rejects(()=>s3.send(new CompleteMultipartUploadCommand({Bucket:b,Key:cp.key,UploadId:upload.UploadId!,IfNoneMatch:"*",MultipartUpload:{Parts:[{PartNumber:1,ETag:part.ETag}]}})),(error:unknown)=>(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===412);
    }finally{await s3.send(new AbortMultipartUploadCommand({Bucket:b,Key:cp.key,UploadId:upload.UploadId!}));}
    assert.equal((await watershedBackup(b))?.metadata.sha384,cp.metadata.sha384);
    await status(await commit(app.url,"large",bytes("suffix"),1n),201);await stop(app.process);
    const restored=await server(b);assert.equal((await epilogueStatus(restored.url,"large")).latest?.viewpoint,1n);await stop(restored.process);
  }
  console.log("put of success: multipart snapshots preserve metadata, conditional creation, and suffix recovery");
  // A GET capability exposes precisely one marker, even while its event also
  // contains other Flows, older markers, and database pages.
  {
    const b=await bucket();
    const app=await server(b,endpoint,{BASINSYNC_BATCH_MAX:"4",BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const target=new Uint8Array(65536);for(let n=0;n<target.length;n++)target[n]=n%251;
    const inputs:[string,Uint8Array,bigint][]=[["public",bytes("old public marker"),0n],["private",bytes("PRIVATE: must never escape through the public capability"),0n],["public",target,1n],["empty",new Uint8Array(),0n]];
    const requests:Promise<Response>[]=[];for(const [flow,blob,vp] of inputs){requests.push(commit(app.url,flow,blob,vp));await queued(app.log,flow,Number(vp));}
    for(const response of await Promise.all(requests))await status(response,201);
    const stored=await get(b,1n),ranges=rangesAt(stored),range=ranges.find(r=>r.flow==="public"&&r.marker.viewpoint==="1")!;
    const footer=await s3.send(new GetObjectCommand({Bucket:b,Key:key(1n),Range:"bytes=-8"}));
    const tailBytes=await footer.Body!.transformToByteArray();assert.equal(tailBytes.length,8);
    const contentLength=new DataView(tailBytes.buffer,tailBytes.byteOffset,tailBytes.byteLength).getUint32(0,true);
    const span=16+Math.ceil(contentLength/8)*8;
    const last=await s3.send(new GetObjectCommand({Bucket:b,Key:key(1n),Range:`bytes=-${span}`}));
    const manifestBytes=await last.Body!.transformToByteArray(),manifest=previousEnvelope(manifestBytes,manifestBytes.length);
    const query=toObject(new Uint8Array(manifest.content)) as any[];
    assert.equal(query[2],"sts/0/databasin/rangemanifest");
    assert.deepEqual(Object.keys(query[3].envelopes),envelopes(stored).slice(0,-1).map(e=>lex(BigInt(e.end))));
    const current=(await fullStatus(app.url,"public")).latest!;
    assert.equal(current.viewpoint,1n);assert.equal(current.length,target.length);
    assert.equal(current.headers?.Range,`bytes=${range.offset}-${range.offset+range.length-1}`);
    assert.equal(new URL(current.url!).searchParams.get("X-Amz-SignedHeaders"),"host;if-match;range");
    assert.deepEqual(await latestBlob(current),target);
    assert.equal(current.headers?.["If-Match"],"*");
    const direct=await fetch(current.url!,{headers:current.headers});assert.equal(direct.status,206);
    assert.equal(direct.headers.get("content-range"),`bytes ${range.offset}-${range.offset+range.length-1}/${stored.length}`);await direct.arrayBuffer();
    const alteredHeaders:(Record<string,string>|undefined)[]=[undefined,{"If-Match":"*"},{Range:current.headers!.Range},{...current.headers,"If-Match":"\"different\""},{...current.headers,Range:`bytes=0-${stored.length-1}`},{...current.headers,Range:`bytes=${range.offset}-${range.offset}`},{...current.headers,Range:`bytes=${range.offset}-${range.offset+range.length-1},0-7`}];
    for(const headers of alteredHeaders){
      const refused=await fetch(current.url!,{headers});assert(refused.status>=400,"an omitted, changed, or expanded Range must fail authentication");
      const body=await refused.text();assert(!body.includes("PRIVATE:"));
    }
    const empty=(await fullStatus(app.url,"empty")).latest!;assert.equal(empty.length,0);assert(!("url" in empty));assert.deepEqual(await latestBlob(empty),new Uint8Array());
    await stop(app.process);
    const restarted=await server(b);assert.deepEqual(await latestBlob((await fullStatus(restarted.url,"public")).latest!),target);await stop(restarted.process);
    // Hold downstream copying: the URL must stay range-bound until the exact
    // marker is stored, then it may use the Flow's whole-object URL.
    const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    const proxy=relay((_,response)=>response,async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes("/flows/")){entered.resolve();await gate.promise;}});
    const copying=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await timeout(entered.promise);
    assert.deepEqual(await latestBlob((await fullStatus(copying.url,"public")).latest!),target);
    gate.resolve();
    await eventually(()=>flowBlob(b,"public",1n),blob=>blob!==null);
    const complete=await eventually(()=>fullStatus(copying.url,"public"),s=>!!s.latest?.url&&!s.latest.headers?.Range);
    assert(new URL(complete.latest!.url!).pathname.endsWith(`/${flowKey("public",1n)}`));
    assert.deepEqual(complete.latest!.headers,{"If-Match":"*"});assert.deepEqual(await latestBlob(complete.latest!),target);
    assert.equal(new URL(complete.latest!.url!).searchParams.get("X-Amz-SignedHeaders"),"host;if-match");
    const unguarded=await fetch(complete.latest!.url!);assert(unguarded.status>=400,"a missing signed condition must fail authentication");await unguarded.arrayBuffer();
    assert(!("url" in (await fullStatus(copying.url,"empty")).latest!));
    const checkpoint=await eventually(()=>watershedBackup(b),cp=>cp?.milestone===1n);assert(checkpoint);
    const path=`${artifacts}/ranges-backup.turso`;writeFileSync(path,checkpoint.blob);
    for(const item of ranges){
      const inspect=spawn([`${root}/target/debug/examples/frame-fixture`,"--locate",path,item.flow,item.marker.viewpoint],{cwd:root,stdout:"pipe",stderr:"inherit"});
      const row=await new Response(inspect.stdout).json();assert.equal(await inspect.exited,0);
      assert.deepEqual(row,{upstream:lex(1n),downstream:lex(BigInt(item.marker.viewpoint)),offset:item.offset,length:item.length,sha384:item.marker.sha384});
    }
    await stop(copying.process);
    const tail=await server(b);await status(await commit(tail.url,"public",bytes("after checkpoint"),2n),201);await stop(tail.process);
    const anchored=await server(b);const latest=(await fullStatus(anchored.url,"public")).latest!;
    assert.equal(latest.viewpoint,2n);assert(new URL(latest.url!).pathname.endsWith(`/${key(2n)}`));assert.deepEqual(await latestBlob(latest),bytes("after checkpoint"));await stop(anchored.process);
  }
  console.log("put of success: signed blob-only Range capabilities, empty markers, downstream URL reuse, persistent locations, and snapshot-plus-suffix recovery");
  // Current observers need no LIST; a positive successor probe discovers the
  // Watershed anchor before replay. Flow marker selection never lists its Epilogue.
  {
    const b=await bucket(),reads:{method:string;url:URL}[]=[];
    const proxy=relay((request,response)=>{reads.push({method:request.method,url:new URL(request.url)});return response;});
    const observer=await server(b,proxy.url);
    async function checkedStatus(flow:string,advanced=false){
      reads.length=0;
      const state=await fullStatus(observer.url,flow);
      const lists=reads.filter(r=>r.url.searchParams.has("list-type"));
      assert(!lists.some(r=>r.url.searchParams.get("prefix")?.startsWith("flows/")),"never list a Flow Epilogue");
      if(advanced){
        assert(lists.some(r=>r.url.searchParams.get("prefix")==="epilogue/"),"discover the latest Watershed anchor after a positive probe");
        assert.equal(reads[0].method,"HEAD");assert(reads[0].url.pathname.includes("/timeline/"));
      }else assert.equal(lists.length,0,"an absent successor avoids all LIST operations");
      return payload(state);
    }
    assert.deepEqual(await checkedStatus("absent"),{latest:null});
    const writer=await server(b);
    await status(await commit(writer.url,"known",a,0n),201);
    assert.deepEqual(await latestBlob((await checkedStatus("known",true)).latest!),a);
    await status(await commit(writer.url,"known",bytes("next"),1n),201);
    await status(await commit(writer.url,"empty",new Uint8Array(),0n),201);
    const pending=(await checkedStatus("known",true)).latest!;
    assert.equal(pending.viewpoint,1n);assert(pending.headers?.Range);
    assert.deepEqual(await latestBlob(pending),bytes("next"));
    assert.deepEqual(await checkedStatus("empty"),{latest:{viewpoint:0n,length:0}});
    // Leave this observer behind; snapshot discovery should skip older events.
    await status(await commit(writer.url,"known",bytes("third"),2n),201);
    await status(await commit(writer.url,"known",bytes("fourth"),3n),201);
    await stop(writer.process);
    const copying=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    await eventually(()=>watershedBackup(b),cp=>cp?.milestone===5n);
    assert.deepEqual(await flowBlob(b,"known",3n),bytes("fourth"));
    const stored=(await checkedStatus("known",true)).latest!;
    assert.equal(stored.viewpoint,3n);assert.deepEqual(stored.headers,{"If-Match":"*"});
    assert(!reads.some(r=>r.method==="GET"&&r.url.pathname.includes("/timeline/")),"load the newer snapshot instead of replaying its prefix");
    assert.deepEqual(await latestBlob(stored),bytes("fourth"));
    assert.deepEqual((await checkedStatus("known")).latest?.headers,{"If-Match":"*"});
    await status(await commit(copying.url,"known",bytes("suffix"),4n),201);
    const suffix=(await checkedStatus("known",true)).latest!;
    assert.equal(suffix.viewpoint,4n);assert.deepEqual(await latestBlob(suffix),bytes("suffix"));
    assert.deepEqual(await checkedStatus("absent"),{latest:null});
    await stop(copying.process);await stop(observer.process);
  }
  console.log("put of success: latest-only status probes successors, discovers newer snapshots only when behind, and never lists Flow Epilogues");
  // Probe freshness is Watershed-wide; status cache hits never extend the window.
  {
    const b=await bucket(),reads:{method:string;url:URL}[]=[];
    const proxy=relay((request,response)=>{reads.push({method:request.method,url:new URL(request.url)});return response;});
    const observer=await server(b,proxy.url,{BASINSYNC_STATUS_PROBE_MAX_AGE_MS:"3000"});
    const writer=await server(b);
    function probes(){return reads.filter(r=>r.method==="HEAD"&&r.url.pathname.includes("/timeline/"));}
    reads.length=0;
    const initial=await fullStatus(observer.url,"external");
    assert.equal(initial.timelines.watershed.milestone,0n);assert.deepEqual(payload(initial),{latest:null});
    assert.equal(probes().length,1,"first status probes immediately");
    const written=await commit(writer.url,"external",a,0n);
    const receipt=parse<CommitResponse>(await written.clone().text());
    assert.equal(receipt.timelines.watershed.milestone,1n);await status(written,201);
    reads.length=0;
    const stale=await fullStatus(observer.url,"external");
    assert.deepEqual(payload(stale),{latest:null});
    assert(stale.timelines.watershed.milestone<receipt.timelines.watershed.milestone,"a different instance exposes its older causal prefix");
    assert.deepEqual(payload(await fullStatus(observer.url,"another-flow")),{latest:null});
    assert.equal(reads.length,0,"all Flows reuse the recent Watershed check");
    await Bun.sleep(1600);
    assert.deepEqual(payload(await fullStatus(observer.url,"external")),{latest:null});
    assert.equal(reads.length,0,"cache hits do not probe");
    await Bun.sleep(1600);
    const refreshed=await fullStatus(observer.url,"external");
    assert.equal(refreshed.timelines.watershed.milestone,1n);
    const caughtUp=refreshed.latest!;
    assert.equal(caughtUp.viewpoint,0n);assert(probes().length>0,"expiry probes and refreshes despite intervening cache hits");
    assert.deepEqual(await latestBlob(caughtUp),a);
    await status(await commit(writer.url,"external",bytes("external next"),1n),201);
    // A write must refresh even while status would accept the old check.
    reads.length=0;
    const localWrite=await commit(observer.url,"local",a,0n);
    assert.equal(parse<CommitResponse>(await localWrite.clone().text()).timelines.watershed.milestone,3n);
    await status(localWrite,201);
    assert(reads.some(r=>r.url.searchParams.get("prefix")==="epilogue/"),"writes always discover the Watershed anchor");
    reads.length=0;
    const local=await fullStatus(observer.url,"local");
    assert.equal(local.timelines.watershed.milestone,3n);
    assert.equal(local.latest?.viewpoint,0n,"own acknowledged writes remain visible");
    assert.equal((await fullStatus(observer.url,"external")).latest?.viewpoint,1n,"write refresh also advances status state");
    assert.equal(probes().length,0,"a successful write refresh renews the check");
    const conflict=await commit(observer.url,"local",a,0n);
    assert.equal(parse<ViewpointMismatch>(await conflict.clone().text()).timelines.watershed.milestone,3n);
    await mismatch(conflict,1n);
    const invalid=await fetch(`${observer.url}/api/v0/epilogue/status`);
    assert.equal(parse<ApiError>(await invalid.clone().text()).timelines.watershed.milestone,3n);
    await status(invalid,400);
    await stop(writer.process);await stop(observer.process);
  }
  console.log("put of success: bounded probe freshness, causal-reverse detection across instances, and durable response positions for writes, status, and errors");
  // Real conditional HEADs yield 304 for present keys. Exercise both missing-key
  // responses, an endpoint ignoring conditions, and failures that must not look absent.
  for(const mode of ["native","missing-412","ignored","denied","unavailable"]){
    const b=await bucket();let present=0,absent=0;
    const proxy=relay((request,response)=>{
      const url=new URL(request.url),object=url.pathname.split("/").slice(2).join("/");
      if(object&&["GET","HEAD"].includes(request.method))assert.equal(request.headers.get("if-match"),"*");
      if(request.method!=="HEAD"||!object)return response;
      const probe=url.pathname.includes("/timeline/");
      if(probe){
        assert.equal(request.headers.get("if-none-match"),"*");
        if(mode==="denied")return new Response(null,{status:403});
        if(mode==="unavailable")return new Response(null,{status:500});
        if(response.status===304){present++;if(mode==="ignored")return new Response(null,{status:200});}
      }
      if(response.status===404){absent++;if(mode==="missing-412")return new Response(null,{status:412});}
      return response;
    });
    const observer=await server(b,proxy.url);
    const initial=await fetch(`${observer.url}/api/v0/epilogue/status?flow=conditional`);
    if(mode==="denied"||mode==="unavailable"){
      await status(initial,503);assert.equal(await timeout(observer.process.exited),1);continue;
    }
    await status(initial,200);
    const writer=await server(b);await status(await commit(writer.url,"conditional",a,0n),201);
    const found=await fullStatus(observer.url,"conditional");
    assert.equal(found.latest?.viewpoint,0n);assert.deepEqual(await latestBlob(found.latest!),a);
    assert(present>0&&absent>0,"exercise both branches of conditional existence search");
    await stop(writer.process);await stop(observer.process);
  }
  console.log("put of success: conditional reads, 304/412/404 probe compatibility, and fail-closed authorization/service errors");
  // Heap staging journals derived identifiers, never authentication material.
  {
    const b=await bucket(),stateDir=`${artifacts}/heap-state`;
    const app=await server(b,endpoint,{BASINSYNC_DATA_DIR:stateDir});
    const flow="0x/雪/staging",secret=bytes("client-only-heap-secret-44b5317c76db0c09"),emptySecret=bytes("client-only-empty-node-secret-d9a812f"),oversize=bytes("oversized-client-token-"+"x".repeat(64));
    const id=(token:Uint8Array,height=0)=>`n-${lex(~BigInt(height))}/v.${lex(0n)}/t.${lex(BigInt(token.length))}/d_${sha384(token)}`;
    const owner=(f:string,v:bigint)=>`A_${f}/v.${lex(0n)}/e.${lex(v)}`;
    const node=(token=secret,length=7):HeapNode=>({auth:[0,0,token],length,edges:[]});
    async function reserved(response:Response){await status(response.clone(),200);return parse<HeapResponse>(await response.text());}
    async function inspectHeap(image:Uint8Array,token:Uint8Array,f=flow,v=0n){
      const path=`${artifacts}/heap-inspect.turso`;writeFileSync(path,image);
      const result=spawn([`${root}/target/debug/examples/frame-fixture`,"--heap",path,id(token),owner(f,v)],{cwd:root,stdout:"pipe",stderr:"inherit"});
      const row=await new Response(result.stdout).json();assert.equal(await result.exited,0);return row;
    }
    const input=[node(),{...node(),auth:[1,0,secret] as HeapNode["auth"]},{...node(),auth:[0,1,secret] as HeapNode["auth"]},{...node(),edges:["target"]},node(oversize),node(),node(secret,8),node(emptySecret,0)];
    const response=await reserved(await reserveHeap(app.url,flow,0n,input));
    assert.equal(response.timelines.watershed.milestone,1n);
    assert.deepEqual(Object.keys(response.results!),["0","5","7"]);
    assert.deepEqual(Object.keys(response.errors!),["1","2","3","4","6"]);
    assert.deepEqual(Object.values(response.errors!).map(e=>e.code),["unsupported_height","unsupported_version","unsupported_edges","token_limit","length_collision"]);
    const actions=response.results![0].actions,zero=response.results![7].actions;
    assert(actions.write&&actions.preview&&zero.write&&zero.preview);
    const revision = new URL(actions.write.url).pathname.split("/").at(-1)!;
    assert.match(revision,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert(new URL(actions.write.url).pathname.endsWith(`/heap/young/${id(secret)}/${revision}`));
    assert(new URL(actions.read.url).pathname.endsWith(`/heap/old/${id(secret)}/${revision}`));
    assert.equal(new URL(actions.write.url).searchParams.get("X-Amz-SignedHeaders"),"content-length;host;if-none-match");
    assert.deepEqual(actions.write.headers,{"Content-Length":"7","If-None-Match":"*"});
    for(const action of [actions.preview,actions.read]){assert.equal(action.headers["If-Match"],"*");const r=await fetch(action.url,{headers:action.headers});assert([404,412].includes(r.status));await r.arrayBuffer();}
    const first=await get(b,1n),tuples=eventTuples(first);assert.equal(tuples[0][2],reservePath);
    const command=tuples[0][3] as {flow:string;viewpoint:string;nodes:{id:string;length:number}[]};
    assert.equal(command.flow,flow);assert.equal(command.viewpoint,"0");assert.equal(command.nodes.length,2);
    const delta=deltasAt(first).turso["default.turso"] as WalDelta;
    let image=ingestWal(delta.logical.base!,delta.physical.segments);
    const original=await inspectHeap(image,secret);assert.equal(original.length,7);assert.equal(original.etag,"");assert.equal(original.promoted,"");assert(original.retained);assert(Number.isFinite(Date.parse(original.reserved)));
    const badWrites:[Record<string,string>,Uint8Array][]=[[{"Content-Length":"7"},bytes("payload")],[{...actions.write.headers,"Content-Length":"8"},bytes("payload!")]];
    for(const [headers,body] of badWrites){
      const rejected:Response=await fetch(actions.write.url,{method:"PUT",headers,body:new Blob([new Uint8Array(body)])});assert(rejected.status>=400,"changing length or omitting the write condition invalidates the signature");await rejected.arrayBuffer();
    }
    assert.equal((await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"heap/young/"}))).KeyCount,0);
    const put=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:bytes("payload")});assert(put.ok,await put.text());
    const duplicate=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:bytes("changed")});assert.equal(duplicate.status,412);await duplicate.arrayBuffer();
    const preview=await fetch(actions.preview.url,{headers:actions.preview.headers});assert.equal(preview.status,200);assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),bytes("payload"));
    const emptyPut=await fetch(zero.write.url,{method:"PUT",headers:zero.write.headers,body:new Uint8Array()});assert(emptyPut.ok,await emptyPut.text());
    const emptyGet=await fetch(zero.preview.url,{headers:zero.preview.headers});assert.equal(emptyGet.status,200);assert.equal((await emptyGet.arrayBuffer()).byteLength,0);
    await s3.send(new PutObjectCommand({Bucket:b,Key:`heap/old/${id(secret)}/${revision}`,Body:bytes("payload")}));
    const old=await fetch(actions.read.url,{headers:actions.read.headers});assert.equal(old.status,200);assert.deepEqual(new Uint8Array(await old.arrayBuffer()),bytes("payload"));
    const retry=await reserved(await reserveHeap(app.url,flow,0n,[node(),node()]));assert.equal(retry.errors,null);assert.deepEqual(Object.keys(retry.results!),["0","1"]);
    const other=await reserved(await reserveHeap(app.url,"another-flow",0n,[node()]));assert.equal(other.errors,null);
    await mismatch(await reserveHeap(app.url,flow,1n,[node()]),0n);
    await status(await commit(app.url,flow,bytes("root marker"),0n),201);
    await mismatch(await reserveHeap(app.url,flow,0n,[node()]),1n);
    await mismatch(await reserveHeap(app.url,flow,2n,[node()]),1n);
    await reserved(await reserveHeap(app.url,flow,1n,[node()]));
    const invalid=await reserved(await reserveHeap(app.url,flow,1n,[{...node(),auth:[0,0,"client-only-malformed-auth-secret"]} as unknown as HeapNode]));
    assert.equal(invalid.results,null);assert.equal(invalid.errors![0].code,"invalid_node");assert.equal(invalid.timelines.watershed.milestone,5n);
    const empty=await reserved(await reserveHeap(app.url,flow,1n,[]));assert.equal(empty.errors,null);assert.equal(empty.results,null);assert.equal(empty.timelines.watershed.milestone,5n);
    await stop(app.process);
    const copying=await server(b,endpoint,{BASINSYNC_DATA_DIR:stateDir,BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const cp=await eventually(()=>watershedBackup(b),value=>value?.milestone===5n);assert(cp);
    for(let m=2n;m<=5n;m++)image=ingestWal(image,(deltasAt(await get(b,m)).turso["default.turso"] as WalDelta).physical.segments);
    assert.deepEqual(cp.blob,image,"reservations and markers share physical recovery and snapshotting");
    assert.deepEqual(await inspectHeap(cp.blob,secret),original,"retries retain original node metadata");
    assert((await inspectHeap(cp.blob,secret,"another-flow")).retained);assert((await inspectHeap(cp.blob,secret,flow,1n)).retained);
    await stop(copying.process);
    const restored=await server(b,endpoint,{BASINSYNC_DATA_DIR:stateDir});
    const replayed=await reserved(await reserveHeap(restored.url,flow,1n,[node()]));assert.equal(replayed.errors,null);assert.equal(replayed.timelines.watershed.milestone,6n);
    await stop(restored.process);
    const secrets=[secret,emptySecret,oversize,bytes("client-only-malformed-auth-secret")];
    function assertNoTokens(contents:Uint8Array){const value=Buffer.from(contents);for(const token of secrets){assert(!value.includes(token),"raw token persisted");assert(!value.includes(Buffer.from(stringify(token).slice(1,-1))),"JSON0 token persisted");}}
    for await(const page of paginateListObjectsV2({client:s3},{Bucket:b}))for(const object of page.Contents??[]){assertNoTokens(bytes(object.Key!));const stored=await s3.send(new GetObjectCommand({Bucket:b,Key:object.Key!}));assertNoTokens(await stored.Body!.transformToByteArray());}
    function scan(dir:string){for(const name of readdirSync(dir)){const path=resolve(dir,name);if(statSync(path).isDirectory())scan(path);else assertNoTokens(readFileSync(path));}}
    scan(stateDir);for(const log of [app.log,copying.log,restored.log])assertNoTokens(readFileSync(log));
    const smallBucket=await bucket(),limited=await server(smallBucket,endpoint,{BASINSYNC_HEAP_MAX_HEIGHT:"0",BASINSYNC_HEAP_MAX_TOKEN_BYTES:"4"});
    const limits=await reserved(await reserveHeap(limited.url,"limits",0n,[node(bytes("12345")),{...node(bytes("1234")),auth:[1,0,bytes("1234")]},node(bytes("1234"))]));
    assert.equal(limits.errors![0].code,"token_limit");assert.equal(limits.errors![1].code,"height_limit");assert(limits.results![2]);await stop(limited.process);
  }
  console.log("put of success: shallow heap reservations, partial errors, length-bound first-writer uploads, both generations, retries, Viewpoint checks, snapshots, service limits, and no persisted tokens");
  // Reservation and commit batches share the two-slot publication pipeline.
  for(const fault of ["none","before","after"]){
    const b=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let puts=0,done=false;
    const proxy=relay(async(request,response)=>{
      if(fault==="after"&&request.method==="PUT"&&new URL(request.url).pathname.endsWith(`/${key(1n)}`)){await response.arrayBuffer();return new Response("reply lost",{status:503});}return response;
    },async request=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes("/timeline/")){puts++;if(puts===1){entered.resolve();await gate.promise;if(fault==="before")return new Response("not stored",{status:503});}}
    });
    const app=await server(b,proxy.url,{BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",RUST_LOG:"basinsync=debug"});
    const input:HeapNode={auth:[0,0,bytes("pipeline-client-only-access-token")],length:0,edges:[]};
    const reservation=reserveHeap(app.url,"pipelined-heap",0n,[input]).then(r=>{done=true;return r});await timeout(entered.promise);
    const following=commit(app.url,"pipelined-heap",bytes("root"),0n);await batchLogged(app.log,2);
    assert.equal(done,false,"do not release actions before reservation durability");assert.equal(puts,1,"prepared successor must not upload early");
    gate.resolve();const first=await reservation;
    if(fault==="none"){
      await status(first.clone(),200);assert.equal(parse<HeapResponse>(await first.text()).timelines.watershed.milestone,1n);
      const second=await following;await status(second.clone(),201);assert.equal(parse<CommitResponse>(await second.text()).timelines.watershed.milestone,2n);await stop(app.process);
    }else{
      const error=parse<ApiError>(await first.clone().text());assert.equal(error.timelines.watershed.milestone,0n);assert(!("results" in error));await status(first,503);
      await status(await following,503);assert.equal(await timeout(app.process.exited),1);assert.equal(puts,1);
      const restored=await server(b);const retry=await reserveHeap(restored.url,"pipelined-heap",0n,[input]);await status(retry.clone(),200);
      assert.equal(parse<HeapResponse>(await retry.text()).timelines.watershed.milestone,fault==="after"?2n:1n);await stop(restored.process);
    }
  }
  // Concurrent reservers arbitrate with the same conditional Timeline append.
  {
    const b=await bucket(),gate=Promise.withResolvers<void>();let puts=0;
    const proxy=relay((_,response)=>response,async request=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes("/timeline/")){if(++puts===2)gate.resolve();await gate.promise;}
    });
    const apps=await Promise.all([server(b,proxy.url),server(b,proxy.url)]);
    const nodes:HeapNode[]=[{auth:[0,0,bytes("shared-client-only-reservation-secret")],length:0,edges:[]}];
    const results=await timeout(Promise.all(apps.map((app,i)=>reserveHeap(app.url,`heap-race-${i}`,0n,nodes))));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,503]);
    for(let i=0;i<results.length;i++)await status(results[i],results[i].status);
    await Promise.all(apps.map(app=>stop(app.process)));
    const restored=await server(b);for(let i=0;i<2;i++)await status(await reserveHeap(restored.url,`heap-race-${i}`,0n,nodes),200);
    assert.equal((await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"timeline/"}))).KeyCount,3);await stop(restored.process);
  }
  console.log("put of success: pipelined reservation/commit durability, ambiguous reservation recovery, and competing reservers");
  // Independent workers may DELETE the same old revision; neither can erase its replacement.
  {
    const b=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let held=false;
    const proxy=relay((_,response)=>response,async request=>{
      if(request.method==="DELETE"&&new URL(request.url).pathname.includes("/heap/young/")){held=true;entered.resolve();await gate.promise;}
    });
    const options={BASINSYNC_CLEANUP_INTERVAL_MS:"15",BASINSYNC_SWEEP_BATCH_SIZE:"1",BASINSYNC_SWEEP_EDGE_BATCH_SIZE:"1",BASINSYNC_ERASE_BATCH_SIZE:"1",BASINSYNC_ERASE_CONCURRENCY:"1"};
    const app=await server(b,proxy.url,options),secret=bytes("cleanup-reusable-token"),input:HeapNode={auth:[0,0,secret],length:4,edges:[]};
    const reserve=async(url:string,flow:string)=>{const r=await reserveHeap(url,flow,0n,[input]);await status(r.clone(),200);return parse<HeapResponse>(await r.text());};
    const initial=await reserve(app.url,"first"),actions=initial.results![0].actions;assert(actions.write&&actions.preview);
    const oldKey=new URL(actions.write.url).pathname.slice(b.length+2);
    const put=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:bytes("same")});assert(put.ok,await put.text());
    const shared=await reserve(app.url,"shared");assert.equal(new URL(shared.results![0].actions.preview!.url).pathname,new URL(actions.preview.url).pathname);
    await status(await commit(app.url,"first",bytes("marker"),0n),201);
    await eventually(async()=>{
      const listed=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"timeline/"}));
      for(const object of listed.Contents??[]) { const r=await s3.send(new GetObjectCommand({Bucket:b,Key:object.Key!})); if(eventTuples(await r.Body!.transformToByteArray()).some(t=>t[2]==="sts/0/databasin/sweepheap"))return true; }
      return false;
    },Boolean);
    assert(!held,"shared retainers keep the node live");
    await status(await commit(app.url,"shared",bytes("marker"),0n),201);
    await timeout(entered.promise);
    const pending=await reserve(app.url,"reuse");assert.equal(pending.errors![0].code,"node_freed");
    await timeout(status(await commit(app.url,"unrelated",bytes("foreground"),0n),201),3000);
    const competing=await server(b,endpoint,options);
    const replacement=await eventually(()=>reserve(competing.url,"reuse"),r=>r.results!==null);
    const next=replacement.results![0].actions;assert(next.write&&next.preview);
    assert.notEqual(new URL(next.write.url).pathname,new URL(actions.write.url).pathname);
    const upload=await fetch(next.write.url,{method:"PUT",headers:next.write.headers,body:bytes("same")});assert(upload.ok,await upload.text());
    gate.resolve();await Bun.sleep(100);
    const live=await fetch(next.preview.url,{headers:next.preview.headers});assert.equal(live.status,200);assert.equal(await live.text(),"same");
    await stop(app.process);await stop(competing.process);
    // An old still-valid PUT can leave dust, without changing the current revision.
    const late=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:bytes("same")});assert(late.ok,await late.text());
    const objects=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"heap/young/"}));assert.equal(objects.KeyCount,2);assert(objects.Contents!.some(o=>o.Key===oldKey));
    const restored=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const again=await reserve(restored.url,"reuse");assert.equal(new URL(again.results![0].actions.preview!.url).pathname,new URL(next.preview.url).pathname);
    const target=again.timelines.watershed.milestone;
    const cp=await eventually(()=>watershedBackup(b),cp=>cp?.milestone===target);assert(cp);
    let image:Uint8Array|undefined;
    for(let m=1n;m<=target;m++){const delta=deltasAt(await get(b,m)).turso["default.turso"] as WalDelta;image=ingestWal(image??delta.logical.base!,delta.physical.segments);}
    assert.deepEqual(cp.blob,image,"cleanup and revision reuse survive physical replay and snapshot recovery");
    await stop(restored.process);
  }
  for(const fault of ["before","after"]){
    const b=await bucket();let deletes=0,failed=false;const sweeps=new WeakSet<Request>();
    const isSweep=async(request:Request)=>request.method==="PUT"&&new URL(request.url).pathname.includes("/timeline/")&&eventTuples(new Uint8Array(await request.clone().arrayBuffer())).some(t=>t[2]==="sts/0/databasin/sweepheap");
    const proxy=relay(async(request,response)=>{
      if(fault==="after"&&sweeps.has(request)){failed=true;await response.arrayBuffer();return new Response("lost sweep response",{status:503});}return response;
    },async request=>{
      if(request.method==="DELETE")deletes++;
      if(await isSweep(request)){sweeps.add(request);if(fault==="before"){failed=true;return new Response("sweep not stored",{status:503});}}
    });
    const app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"15"});
    const input:HeapNode={auth:[0,0,bytes(`cleanup-durability-${fault}`)],length:0,edges:[]};
    const reserved=await reserveHeap(app.url,"f",0n,[input]);await status(reserved.clone(),200);
    const actions=parse<HeapResponse>(await reserved.text()).results![0].actions;assert(actions.write);
    const upload=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:new Uint8Array()});assert(upload.ok);
    await status(await commit(app.url,"f",bytes("marker"),0n),201);
    assert.equal(await timeout(app.process.exited),1);assert(failed);assert.equal(deletes,0,"no object erasure before acknowledged durable freeing");
    const retry=await server(b,endpoint,{BASINSYNC_CLEANUP_INTERVAL_MS:"15"});
    await eventually(async()=>{const r=await fetch(actions.preview!.url,{headers:actions.preview!.headers});await r.arrayBuffer();return r.status;},n=>n===404||n===412);
    await stop(retry.process);
  }
  console.log("put of success: bounded deferred cleanup, shared retainers, foreground progress during DELETE, revision-safe reuse, late-upload dust, and durable restart recovery");

  console.log(`Integration passed. Logs: ${artifacts}`);
} finally {
  await Promise.all(processes.map(stop));
  await Promise.all(relays.map(r=>r.stop(true)));
  s3.destroy();
}
