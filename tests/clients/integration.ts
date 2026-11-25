import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { resolve } from "node:path";
import { spawn } from "bun";
import { DeleteObjectCommand, HeadObjectCommand, CopyObjectCommand, CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, paginateListObjectsV2 } from "@aws-sdk/client-s3";
import { encode as flexEncode } from "flatbuffers/js/flexbuffers.js";
import { toObject, encode as extensionEncode } from "./flexbuffer";
import { commit, form, epilogueStatus as fullStatus, latestBlob, sha384, sha384Bytes, type ApiError, type CommitResponse, type Timelines, type ViewpointMismatch, reserveHeap, type HeapResponse, type HeapNode } from "./client";
import { parse, stringify } from "./json0";
import { key, fromKey } from "./timeline";
import { decodeBulkOrder } from "./bulkorder";
import { key as epilogueKey, encode as lex, decode as unlex } from "./lexidecimal";
import { encodeEvent, markerAt, deltasAt, legacyDeltasAt, entriesAt, rangesAt, eventTuples, encodeTuples, encodeWalEvent, entryDigest, commandFrames, trimRetryMargins, type WalDelta, type Marker } from "./events";
import { ingestWal } from "./wal";
import { all as envelopes, before as previousEnvelope, message as envelopeMessage, wrap as wrapEnvelope } from "./envbuf";
import { stress } from "./stress";
import { s3Fixture } from "./s3-fixture";
import { objectKeys } from "./object-keys";
import { scenario, passed, report } from "./scenarios";
import { vectors } from "./vectors";
import { committedKeys } from "./listing";

// Cursor cases below assert positions; full capability
// responses and their byte ranges are exercised separately.
function payload<T extends {timelines:Timelines}>(value:T){
  assert(typeof value.timelines?.basin?.milestone==="bigint"&&value.timelines.basin.milestone>=0n,"every API response carries its durable Basin prefix");
  const {timelines,...body}=value;return body;
}
function positions(value:Awaited<ReturnType<typeof fullStatus>>){return {...payload(value),latest:value.latest?{viewpoint:value.latest.viewpoint}:null};}
async function epilogueStatus(...args:Parameters<typeof fullStatus>){return positions(await fullStatus(...args));}

const root = resolve(import.meta.dir,"../..");
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
  return launch([Bun.env.BASINSYNC_SERVER??`${root}/target/debug/basinsync`],{
    BASINSYNC_LOG_FORMAT:"json",S3_ENDPOINT:s3Endpoint,S3_BUCKET:bucket,AWS_REGION:"us-east-1",
    AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,
    AWS_SESSION_TOKEN:"",BASINSYNC_LISTEN:address,BASINSYNC_CLEANUP_INTERVAL_MS:"0",BASINSYNC_BULK_MAX_AGE_MS:"0",BASINSYNC_BACKUP_INTERVAL_MS:"0",BASINSYNC_STATUS_PROBE_MAX_AGE_MS:"0",...options,
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
// Ordering waits observe the documented metrics rather than log text:
// admitted commits (finished plus in flight), prepared commits (admitted minus
// those still queued for preparation), and prepared batches (finished, queued,
// or publishing).
type Progress={admitted:number;prepared:number;batches:number};
async function progress(app:{url:string}):Promise<Progress>{
  const text=await (await fetch(`${app.url}/metrics`,{signal:AbortSignal.timeout(5000)})).text();
  // Series without a label also count, so these waits test ordering, not label
  // conformance (the observability suite checks labels).
  const sum=(name:string,labels:Record<string,string>={})=>text.split("\n")
    .filter(l=>(l.startsWith(name+"{")||l.startsWith(name+" "))&&Object.entries(labels).every(([k,v])=>l.includes(`${k}="${v}"`)||!l.includes(`${k}="`)))
    .reduce((total,l)=>total+Number(l.slice(l.lastIndexOf(" ")+1)),0);
  const commit={operation:"commit"};
  const admitted=sum("basinsync_submissions_total",commit)+sum("basinsync_submissions_inflight",commit);
  return {admitted,prepared:admitted-sum("basinsync_requests_queued",commit),
    batches:sum("basinsync_batches_total")+sum("basinsync_batches_queued")+sum("basinsync_batches_publishing")};
}
async function reach(app:{url:string},key:keyof Progress,count:number){
  const deadline=Date.now()+15000;let last:Progress|undefined;
  while(!(last=await progress(app).catch(()=>undefined))||last[key]<count){
    assert(Date.now()<deadline,`${key} never reached ${count}: ${JSON.stringify(last)}`);await Bun.sleep(2);
  }
}
// Start a request and return once the server has admitted it, so successive
// requests reach its queue in order. The pending result is boxed so awaiting
// this helper does not await the request.
async function admit<T>(app:{url:string},send:()=>Promise<T>):Promise<[Promise<T>]>{
  const {admitted}=await progress(app);const pending=send();pending.catch(()=>{});
  await reach(app,"admitted",admitted+1);return [pending];
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
  assert.deepEqual(JSON.parse(body),{next:{viewpoint:`0x${next.toString(16)}`},timelines:{basin:{milestone:`0x${response.timelines.basin.milestone.toString(16)}`}}});
  assert.deepEqual(payload(response),{next:{viewpoint:next}});
}
async function get(bucket: string, milestone: bigint) {
  const r = await s3.send(new GetObjectCommand({Bucket:bucket,Key:key(milestone)}));
  return r.Body!.transformToByteArray();
}
async function assertManifestRange(bucket:string,milestone:bigint,stored?:Uint8Array){
  stored??=await get(bucket,milestone);
  const frame=commandFrames(stored).filter(e=>e.format!==6).at(-1)!;
  const head=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key(milestone)}));
  const range=head.Metadata?.["manifest-range"];
  assert.equal(range,`bytes=${frame.start}-${frame.end-1}`);
  const selected=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key(milestone),Range:range}));
  assert.equal(selected.$metadata.httpStatusCode,206);
  assert.deepEqual(await selected.Body!.transformToByteArray(),stored.slice(frame.start,frame.end));
}
const marker = (blob: Uint8Array, viewpoint="0"): Marker => ({blob,viewpoint,sha384:sha384(blob),edges:[],context:{}});
async function seed(bucket: string, milestone: bigint, payload: Uint8Array) {
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:key(milestone),Body:payload}));
}
async function badStartup(bucket: string) {
  assert.equal(await timeout(serverProcess(bucket,endpoint,"127.0.0.1:0").exited),1);
}

function isBasinPut(request:Request){const path=new URL(request.url).pathname;return request.method==="PUT"&&path.includes("/epilogue/0y")&&!path.includes(`/${objectKeys.userFlows}`);}
// A Flow's revision is observable through its Epilogue keys,
// userspace/flows/<flow>/<revision>/epilogue/..., once markers or signs land there,
// and from the documented Turso state deltas before any object exists; both
// sources must agree.
async function flowRevisions(b:string):Promise<Record<string,string>> {
  const revisions:Record<string,string>={};
  for(const key of await committedKeys(s3,b,objectKeys.userFlows)){
    const [flow,revision]=key.slice(objectKeys.userFlows.length).split("/");
    if(!flow||!revision)continue;
    assert.match(revision,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert(!revisions[flow]||revisions[flow]===revision,`Flow ${flow} has more than one revision`);
    revisions[flow]=revision;
  }
  const internal=await materializedRevisions(b);
  for(const [flow,revision] of Object.entries(revisions))assert.equal(internal[flow],revision,`Flow ${flow} keys disagree with materialized state`);
  return {...internal,...revisions};
}
async function materializedRevisions(b:string):Promise<Record<string,string>> {
  let image:Uint8Array|undefined;
  for(const m of (await committedKeys(s3,b,objectKeys.timeline)).map(fromKey).sort((a,b)=>a<b?-1:1)){
    const d=deltasAt(await get(b,m)).turso["default.turso"]!;
    image??=new Uint8Array(d.logical.base!);
    if("segments" in d.physical)image=ingestWal(image,d.physical.segments);
    else{const next=new Uint8Array(d.physical.size);next.set(image.subarray(0,next.length));for(const p of d.physical.pages)next.set(p.data,(p.number-1)*16384);image=next;}
  }
  assert(image);const path=`${artifacts}/revisions-${serial++}.turso`;writeFileSync(path,image);
  const p=spawn([`${root}/target/debug/examples/frame-fixture`,"--revisions",path],{cwd:root,stdout:"pipe",stderr:"inherit"});
  const revisions=await new Response(p.stdout).json() as Record<string,string>;assert.equal(await p.exited,0);
  for(const revision of Object.values(revisions))assert.match(revision,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return revisions;
}
const revisions=new Map<string,string>();
async function flowPrefix(b:string,flow:string){
  flow=flow.toLowerCase();
  const cacheKey=JSON.stringify([b,flow]);let revision=revisions.get(cacheKey);
  if(!revision){revision=(await eventually(()=>flowRevisions(b),r=>!!r[flow]))[flow]!;revisions.set(cacheKey,revision);}
  return `${objectKeys.userFlows}${flow.toLowerCase()}/${revision}/epilogue/`;
}
async function signKey(b:string,flow:string,vp:bigint){return `${await flowPrefix(b,flow)}${lex(vp)}`;}
async function exists(b:string,key:string){try{await s3.send(new HeadObjectCommand({Bucket:b,Key:key,IfMatch:"*"}));return true;}catch(e){if([404,412].includes((e as {$metadata: {httpStatusCode:number}}).$metadata.httpStatusCode))return false;throw e;}}
async function flowKey(b:string,flow:string,vp:bigint){return `${await flowPrefix(b,flow)}${epilogueKey(vp).slice(objectKeys.basinEpilogue.length)}`;}
async function flowBlob(bucket:string,flow:string,viewpoint:bigint):Promise<Uint8Array|null>{
  try{
    const response=await s3.send(new GetObjectCommand({Bucket:bucket,Key:await flowKey(bucket,flow,viewpoint)}));
    return envelopeMessage(await response.Body!.transformToByteArray());
  }catch(error){
    if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return null;
    throw error;
  }
}
async function eventually<T>(read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+15000;let last:unknown;
  while(Date.now()<deadline){try{const value=await read();if(done(value))return value;last=value;}catch(error){last=error;}await Bun.sleep(10);}
  throw new Error(`condition not reached: ${JSON.stringify(last,(_key,value)=>typeof value==="bigint"?value.toString():value)}; ${artifacts}`);
}
async function basinBackup(bucket:string){
  const list=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:objectKeys.basinEpilogue}));
  const key=list.Contents?.find(o=>o.Size!>=16&&o.Key!.startsWith(`${objectKeys.basinEpilogue}0y`))?.Key;if(!key)return null;
  const response=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
  const object=await response.Body!.transformToByteArray();
  const marker=envelopeMessage(object);
  let blob=marker;
  if(new TextDecoder().decode(marker.subarray(0,16))!=="SQLite format 3\0"){
    const graph=toObject(marker) as {databases:Record<string,{id:string;revision:string}>};
    const node=graph.databases["default.turso"];
    for(const generation of ["old","young"]){
      try{const image=await s3.send(new GetObjectCommand({Bucket:bucket,Key:`${objectKeys.kernelHeap}${generation}/${node.id}/${node.revision}`}));blob=await image.Body!.transformToByteArray();break;}
      catch(error){if(generation==="young"||(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw error;}
    }
  }
  return {key,milestone:BigInt(response.Metadata!.milestone),metadata:response.Metadata!,object,marker,blob};
}
async function inspectImage(blob:Uint8Array){
  const path=`${artifacts}/inspect-${serial++}.turso`;writeFileSync(path,blob);
  const inspector=spawn([`${root}/target/debug/examples/frame-fixture`,"--inspect",path],{cwd:root,stdout:"pipe",stderr:"inherit"});
  const value=await new Response(inspector.stdout).json() as {milestone:string;flows:Record<string,string>};assert.equal(await inspector.exited,0);return value;
}

try {
  const gatewayConfig=s3Fixture(root,endpoint,`${artifacts}/s3`,credentials);
  const gateway = launch(gatewayConfig.command,gatewayConfig.env);
  await ready(gateway,async()=>{await s3.send(new CreateBucketCommand({Bucket:"readiness"}));});
  const b = await bucket();
  // A successful COPY alone does not prove its destination conditions are atomic.
  await scenario("0zg1 timeline race", "bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (1/7)", async () => {
    const sources=await Promise.all(Array.from({length:8},async(_,n)=>{
      const Key=`conformance/source-${n}`,Body=bytes(`source-${n}`);
      const result=await s3.send(new PutObjectCommand({Bucket:b,Key,Body}));return {Key,Body,etag:result.ETag!};
    }));
    const Key="conformance/winner";
    const results=await Promise.all(sources.map(async source=>{
      try{await s3.send(new CopyObjectCommand({Bucket:b,Key,CopySource:`${b}/${source.Key}`,CopySourceIfMatch:source.etag,IfNoneMatch:"*"}));return 200;}
      catch(error){return (error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode;}
    }));
    assert.equal(results.filter(s=>s===200).length,1,"conditional COPY must have one winner");
    assert.equal(results.filter(s=>s===412).length,7);
    const winner=sources[results.indexOf(200)];
    assert.deepEqual(await (await s3.send(new GetObjectCommand({Bucket:b,Key}))).Body!.transformToByteArray(),winner.Body);
    await assert.rejects(s3.send(new CopyObjectCommand({Bucket:b,Key:"conformance/bad-source",CopySource:`${b}/${winner.Key}`,CopySourceIfMatch:'"incorrect"',IfNoneMatch:"*"})),(error:any)=>error.$metadata?.httpStatusCode===412);
    await assert.rejects(s3.send(new CopyObjectCommand({Bucket:b,Key,CopySource:`${b}/${winner.Key}`,IfMatch:'"incorrect"'})),(error:any)=>error.$metadata?.httpStatusCode===412);
    console.log("put of success: COPY enforces source ETags and atomic destination preconditions");
  });
  const probeBucket=await bucket();
  const reference=await s3.send(new PutObjectCommand({Bucket:probeBucket,Key:objectKeys.emptySentinel,Body:new Uint8Array(),IfNoneMatch:"*"}));
  const emptyETag=reference.ETag!;assert(emptyETag);
  // Bootstrap learns opaque validators, preserves an existing reference, and rejects a nonempty one.
  await scenario("0zg1 timeline race", "bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (2/7)", async () => {
    const name=await bucket(),opaque='"bucket-empty-validator"';let probes=0;
    await s3.send(new PutObjectCommand({Bucket:name,Key:objectKeys.emptySentinel,Body:new Uint8Array(),Metadata:{preserved:"yes"}}));
    await s3.send(new PutObjectCommand({Bucket:name,Key:key(1n),Body:new Uint8Array()}));
    const proxy=relay(async (request,response)=>{
      const path=new URL(request.url).pathname;
      // Servers may observe the reference validator by HEAD or GET; rewrite both.
      if((request.method==="HEAD"||request.method==="GET")&&path.endsWith(`/${objectKeys.emptySentinel}`)&&response.status===200){const headers=new Headers(response.headers);headers.set("etag",opaque);return new Response(request.method==="GET"?await response.arrayBuffer():null,{status:200,headers});}
      if(request.method==="HEAD"&&path.includes(`/${objectKeys.timeline}`)&&request.headers.has("if-none-match")){assert.equal(request.headers.get("if-none-match"),opaque);probes++;}
      return response;
    });
    const app=await server(name,proxy.url);await status(await commit(app.url,"opaque-validator",bytes("data"),0n),201);await stop(app.process);assert(probes>0);
    assert.equal((await s3.send(new HeadObjectCommand({Bucket:name,Key:objectKeys.emptySentinel}))).Metadata!.preserved,"yes");
    const invalid=await bucket();await s3.send(new PutObjectCommand({Bucket:invalid,Key:objectKeys.emptySentinel,Body:bytes("not empty")}));await badStartup(invalid);
    assert.deepEqual(await (await s3.send(new GetObjectCommand({Bucket:invalid,Key:objectKeys.emptySentinel}))).Body!.transformToByteArray(),bytes("not empty"));
  });
  const a = bytes("359");assert(sha384(a).startsWith("00"));
  // Probe collisions bound tombstones below sixteen bytes and standalone margins to u8 values 1–7.
  for(const mode of ["selected","all-tombstones","all-margins"]){
    await scenario("0zg1 timeline race", `bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (mode=${mode})`, async () => {
    const b=await bucket(),writes:string[]=[];
    const proxy=relay(async(request,response)=>{
      const path=new URL(request.url).pathname;
      const tomb=path.match(/\/sentinel\/tombstone\/(\d+)$/),pad=path.match(/\/sentinel\/margin\/(\d+)$/);
      const collide=!!tomb&&(mode==="all-tombstones"||mode==="selected"&&Number(tomb[1])<6)||!!pad&&(mode==="all-margins"||mode==="selected"&&Number(pad[1])<7);
      if(response.ok&&collide){const headers=new Headers(response.headers);headers.set("etag",emptyETag);return new Response(await response.arrayBuffer(),{status:response.status,headers});}
      return response;
    },async request=>{const path=new URL(request.url).pathname;if(request.method==="PUT"&&path.includes("/kernelspace/sentinel/")){assert.equal(request.headers.get("if-none-match"),"*");writes.push(path);
      const pad=path.match(/\/sentinel\/margin\/(\d+)$/);if(pad){const frames=envelopes(new Uint8Array(await request.clone().arrayBuffer()));assert.equal(frames.length,1);assert.equal(frames[0]!.end,24);assert.equal(frames[0]!.format,6);assert.deepEqual(frames[0]!.content,new Uint8Array([Number(pad[1])]));}
    }});
    if(mode!=="selected"){
      const process=serverProcess(b,proxy.url,"127.0.0.1:0");assert.equal(await timeout(process.exited),1);
      if(mode==="all-tombstones")assert(writes.some(p=>p.includes("/tombstone/")),"probe tombstones before refusing to start");
      assert(!writes.some(p=>p.endsWith("/tombstone/16")),"sixteen-byte tombstones must never be written");
      if(mode==="all-margins")assert.deepEqual(writes.filter(p=>p.includes("/margin/")).map(p=>p.split("/").at(-1)),Array.from({length:7},(_,i)=>String(i+1)));
      return;
    }
    let app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10",BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    assert.deepEqual(writes.filter(p=>p.includes("/tombstone/")).map(p=>p.split("/").at(-1)),["2","4","6"]);
    assert.deepEqual(writes.filter(p=>p.includes("/margin/")).map(p=>p.split("/").at(-1)),Array.from({length:7},(_,i)=>String(i+1)));
    await status(await commit(app.url,"probed",a,0n),201);
    const sign=await signKey(b,"probed",0n);await eventually(()=>s3.send(new HeadObjectCommand({Bucket:b,Key:sign})),head=>head.ContentLength===24);
    const signFrames=envelopes(await (await s3.send(new GetObjectCommand({Bucket:b,Key:sign}))).Body!.transformToByteArray());assert.equal(signFrames.length,1);assert.equal(signFrames[0]!.format,6);assert.deepEqual(signFrames[0]!.content,new Uint8Array([7]));
    await eventually(()=>basinBackup(b),Boolean);await stop(app.process);
    const cp=await basinBackup(b);assert(cp);const vp=~unlex(cp.key.slice(objectKeys.basinEpilogue.length));
    await s3.send(new PutObjectCommand({Bucket:b,Key:epilogueKey(vp+1n),Body:new Uint8Array([0xde,0xad,0xde,0xad,0xde,0xad])}));
    app=await server(b,proxy.url);assert.equal((await fullStatus(app.url,"probed")).latest?.viewpoint,0n);await stop(app.process);
    });
  }
  await scenario("0zg1 timeline race", "bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (3/7)", async () => {
    const b=await bucket();let armed=false;
    const proxy=relay((_,response)=>response,async request=>{
      if(armed&&request.method==="PUT"&&new URL(request.url).pathname.endsWith(`/${key(1n)}`)){armed=false;await s3.send(new PutObjectCommand({Bucket:b,Key:key(1n),Body:new Uint8Array([0xde,0xad])}));}
    });
    const app=await server(b,proxy.url);armed=true;await status(await commit(app.url,"tombstone",a,0n),503);assert.equal(await timeout(app.process.exited),1);
    assert.deepEqual(await get(b,1n),new Uint8Array([0xde,0xad]),"a competing tombstone can never be replaced");await badStartup(b);
  });
  // This provider adapter gives one successful upload the empty ETag, then honors its CAS retry.
  function collisionProxy(b:string,select:(request:Request)=>boolean,hold=false,missing=false,collisions=1){
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const originals=new Map<string,{body:Uint8Array;etag:string}>(),bodies=new Map<string,Uint8Array>(),validators=new Map<string,string>(),counts=new Map<string,number>();let retries=0;
    const proxy=relay(async(request,response)=>{
      const Key=decodeURIComponent(new URL(request.url).pathname.slice(b.length+2));
      if(request.method==="HEAD"&&originals.has(Key)&&(counts.get(Key)??0)<collisions&&response.ok){
        const headers=new Headers(response.headers);headers.set("etag",emptyETag);
        return new Response(null,{status:request.headers.get("if-none-match")===emptyETag?304:response.status,headers});
      }
      if(request.method==="PUT"&&select(request)&&response.ok){
        const Key=decodeURIComponent(new URL(request.url).pathname.slice(b.length+2));
        if(!originals.has(Key)){
          originals.set(Key,{body:bodies.get(Key)!,etag:response.headers.get("etag")!});validators.set(Key,response.headers.get("etag")!);entered.resolve();if(hold)await release.promise;
          const headers=new Headers(response.headers);if(missing)headers.delete("etag");else headers.set("etag",emptyETag);
          return new Response(await response.arrayBuffer(),{status:response.status,headers});
        }
      }
      return response;
    },async request=>{
      if(request.method!=="PUT"||!select(request))return;
      const Key=decodeURIComponent(new URL(request.url).pathname.slice(b.length+2)),body=new Uint8Array(await request.clone().arrayBuffer());bodies.set(Key,body);
      const original=originals.get(Key);
      if(original&&request.headers.get("if-match")===emptyETag){
        retries++;assert.equal(request.headers.get("if-none-match"),null);
        const frames=(b:Uint8Array)=>{const outer=envelopes(b);return outer.length===1&&outer[0].format===4?commandFrames(b):outer;};
        const previous=frames(original.body).at(-1)!,margin=frames(body).at(-1)!;
        assert.equal(previous.format,6);assert.equal(margin.format,6);assert.equal(body.length,original.body.length);
        assert.deepEqual(body.subarray(0,previous.start),original.body.subarray(0,previous.start));assert.equal(margin.start,previous.start);
        assert.deepEqual(body.subarray(margin.end),original.body.subarray(previous.end),"retry preserves the outer footer");
        const counter=(counts.get(Key)??0)+1;counts.set(Key,counter);
        if(previous.content.length===1){assert.equal(margin.content.length,1);assert.equal(margin.content[0],previous.content[0]+counter);assert(margin.content[0]<=7);}
        else{assert.equal(previous.content.length,8);assert.deepEqual(previous.content,new Uint8Array(8));assert.equal(margin.content.length,8);assert.equal(new DataView(margin.content.buffer,margin.content.byteOffset,8).getBigUint64(0,true),BigInt(counter));}
        const Metadata=Object.fromEntries([...request.headers].filter(([name])=>name.startsWith("x-amz-meta-")).map(([name,value])=>[name.slice(11),value]));
        const put=await s3.send(new PutObjectCommand({Bucket:b,Key,Body:body,IfMatch:validators.get(Key),Metadata}));validators.set(Key,put.ETag!);return new Response(null,{status:200,headers:{etag:counter<collisions?emptyETag:put.ETag!}});
      }
    });
    return {...proxy,entered,release,originals,retries:()=>retries};
  }
  await scenario("0zg1 timeline race", "bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (4/7)", async () => {
    const b=await bucket(),proxy=collisionProxy(b,r=>new URL(r.url).pathname.endsWith(`/${key(1n)}`),true,false,259);
    const app=await server(b,proxy.url,{BASINSYNC_BULK_MAX_AGE_MS:"10",BASINSYNC_BULK_TARGET_BYTES:"1",BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",RUST_LOG:"basinsync=debug"});let done=0;
    const first=fetch(`${app.url}/api/v0/epilogue`,{method:"PUT",body:form("collision",a,0n),signal:AbortSignal.timeout(120000)}).then(r=>{done++;return r});await timeout(proxy.entered.promise);
    const next=fetch(`${app.url}/api/v0/epilogue`,{method:"PUT",body:form("collision",bytes("second"),1n),signal:AbortSignal.timeout(120000)}).then(r=>{done++;return r});await reach(app,"batches",2);assert.equal(done,0);
    proxy.release.resolve();await status(await first,201);await status(await next,201);assert.equal(proxy.retries(),259);
    const payload=await get(b,1n),original=proxy.originals.get(key(1n))!.body;assert.equal(entryDigest(payload),entryDigest(original));assert.notEqual(sha384(payload),sha384(original));
    const archives=await eventually(()=>s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.analogue})),r=>r.KeyCount===1);
    const archived=await s3.send(new GetObjectCommand({Bucket:b,Key:archives.Contents![0].Key!}));assert.deepEqual(decodeBulkOrder(await archived.Body!.transformToByteArray()).events[0],trimRetryMargins(payload),"archive handoff trims the accepted event without changing its command bytes");
    assert.equal((deltasAt(await get(b,2n)).turso["default.turso"] as WalDelta).physical.parent,entryDigest(payload));await assertManifestRange(b,1n,payload);await stop(app.process);
    const replayed=await server(b);assert.equal((await fullStatus(replayed.url,"collision")).latest?.viewpoint,1n);await stop(replayed.process);
    const backed=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await eventually(()=>basinBackup(b),cp=>cp?.milestone===2n);await stop(backed.process);
    const restored=await server(b);assert.deepEqual(await latestBlob((await fullStatus(restored.url,"collision")).latest!),bytes("second"));await stop(restored.process);
  });
  for(const kind of ["marker","backup","sign"]){
    await scenario("0zg1 timeline race", `bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (kind=${kind})`, async () => {
    const b=await bucket(),proxy=collisionProxy(b,r=>{const path=new URL(r.url).pathname;return kind==="marker"?path.includes(`/${objectKeys.userFlows}`):kind==="backup"?isBasinPut(r):path.includes("/epilogue/0z");},false,false,3);
    const app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10",BASINSYNC_CLEANUP_INTERVAL_MS:kind==="sign"?"10":"0"});await status(await commit(app.url,"collision",a,0n),201);
    await eventually(()=>basinBackup(b),Boolean);await eventually(async()=>proxy.retries(),n=>n>0);await stop(app.process);
    const cp=await basinBackup(b);assert(cp);assert.equal((await inspectImage(cp.blob)).flows.collision,"0");
    const restored=await server(b);assert.deepEqual(await latestBlob((await fullStatus(restored.url,"collision")).latest!),a);await stop(restored.process);
    });
  }
  await scenario("0zg1 timeline race", "bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (5/7)", async () => {
    const b=await bucket(),proxy=collisionProxy(b,r=>new URL(r.url).pathname.includes(`/${objectKeys.timeline}`),false,true);
    const app=await server(b,proxy.url);await status(await commit(app.url,"missing-validator",a,0n),503);assert.equal(await timeout(app.process.exited),1);
    const restored=await server(b);assert.equal((await fullStatus(restored.url,"missing-validator")).latest?.viewpoint,0n);await stop(restored.process);
  });
  await scenario("0zg1 timeline race", "bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (6/7)", async () => {
    const b=await bucket(),proxy=collisionProxy(b,r=>new URL(r.url).pathname.includes(`/${objectKeys.userFlows}`)&&new URL(r.url).pathname.includes("/epilogue/0z"),false,false,8);
    const app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10"});await status(await commit(app.url,"bounded-sign",a,0n),201);
    await eventually(async()=>proxy.retries(),retries=>retries>=6);await Bun.sleep(100);
    assert.equal(proxy.retries(),6,"standalone margins stop at counter 7");const Key=await signKey(b,"bounded-sign",0n);
    const sign=envelopes(await (await s3.send(new GetObjectCommand({Bucket:b,Key}))).Body!.transformToByteArray());
    assert.equal(sign.length,1);assert.deepEqual(sign[0]!.content,new Uint8Array([7]));await stop(app.process);
  });
  await scenario("0zg1 timeline race", "bounded tombstone/margin probes, immutable tombstones, upload postconditions, margin retries across all sequence writers, and stable pipelined Timeline digest/recovery (7/7)", async () => {
    const b=await bucket(),proxy=collisionProxy(b,r=>new URL(r.url).pathname.includes(`/${objectKeys.analogue}`),false,false,3);
    const app=await server(b,proxy.url,{BASINSYNC_BULK_MAX_AGE_MS:"10",BASINSYNC_BULK_TARGET_BYTES:"1"});
    await status(await commit(app.url,"bulk-margin",a,0n),201);
    await eventually(async()=>proxy.retries(),n=>n===3);
    // The last counted retry may still be uploading; VersityGW lists its temporary file until the PUT completes.
    const archives=await eventually(()=>s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.analogue})),r=>r.KeyCount===1);
    const {object,body}=await eventually(async()=>{const object=await s3.send(new GetObjectCommand({Bucket:b,Key:archives.Contents![0].Key!}));return {object,body:await object.Body!.transformToByteArray()};},r=>envelopes(r.body).at(-1)!.content[0]===3);
    const order=decodeBulkOrder(body);
    assert.deepEqual(order.events[0],trimRetryMargins(await get(b,1n)));assert.equal(envelopes(body).at(-1)!.content[0],3);
    assert.equal(object.Metadata!["bulkmanifest-range"],`bytes=${order.range.start}-${order.range.end-1}`);
    await stop(app.process);
  });
  // Sequence sentinels are excluded from search and replaced only with their observed ETag.
  await scenario("0zg1 timeline race", "bucket-derived empty sentinel validators, atomic conditional replacement, metadata-only ETag caveat, exclusive search bounds, wrapped empty markers, margin signs, and snapshot recovery (1/3)", async () => {
    const b=await bucket(),replaced=new Set<string>();
    async function sentinel(Key:string){const r=await s3.send(new PutObjectCommand({Bucket:b,Key,Body:new Uint8Array(),Metadata:{reserved:"yes"}}));assert.equal(r.ETag,emptyETag);}
    await sentinel(key(1n));await sentinel(epilogueKey(0n));await sentinel(`${objectKeys.basinEpilogue}${lex(0n)}`);
    const proxy=relay((request,response)=>{
      if(request.method==="PUT"&&request.headers.get("if-match")===emptyETag)replaced.add(decodeURIComponent(new URL(request.url).pathname.slice(b.length+2)));
      return response;
    });
    let app=await server(b,proxy.url);
    assert.equal((await fullStatus(app.url,"sentinel")).latest,null);
    await status(await commit(app.url,"sentinel",new Uint8Array(),0n),201);
    const markerKey=await flowKey(b,"sentinel",0n),sign=await signKey(b,"sentinel",0n);
    await sentinel(markerKey);await sentinel(sign);await stop(app.process);
    app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10",BASINSYNC_CLEANUP_INTERVAL_MS:"10"});
    await eventually(()=>basinBackup(b),Boolean);await eventually(()=>s3.send(new HeadObjectCommand({Bucket:b,Key:sign})),r=>r.ContentLength===24);
    const markerObject=await s3.send(new GetObjectCommand({Bucket:b,Key:markerKey}));
    const markerBytes=await markerObject.Body!.transformToByteArray();assert.equal(envelopeMessage(markerBytes).length,0);assert(markerBytes.length>0);assert.notEqual(markerObject.ETag,emptyETag);
    for(const signKey of [sign]){
      await eventually(()=>s3.send(new HeadObjectCommand({Bucket:b,Key:signKey})),head=>head.ContentLength!>=16);
      const signObject=await s3.send(new GetObjectCommand({Bucket:b,Key:signKey}));const frames=envelopes(await signObject.Body!.transformToByteArray());assert.equal(frames.length,1);assert.equal(frames[0].format,6);assert.deepEqual(frames[0].content,new Uint8Array([1]));assert.notEqual(signObject.ETag,emptyETag);
    }
    await stop(app.process);
    for(const Key of [key(1n),epilogueKey(0n),markerKey,sign])assert(replaced.has(Key),`ETag-guarded replacement: ${Key}`);
    const saved=await basinBackup(b);assert(saved);await sentinel(epilogueKey((~unlex(saved.key.slice(objectKeys.basinEpilogue.length)))+1n));
    const restored=await server(b);assert.equal((await fullStatus(restored.url,"sentinel")).latest?.viewpoint,0n);await stop(restored.process);
  });
  await scenario("0zg1 timeline race", "bucket-derived empty sentinel validators, atomic conditional replacement, metadata-only ETag caveat, exclusive search bounds, wrapped empty markers, margin signs, and snapshot recovery (2/3)", async () => {
    const b=await bucket(),unanchored={BASINSYNC_BACKUP_INTERVAL_MS:"0"},writer=await server(b,endpoint,unanchored);
    for(let n=0;n<3;n++)await status(await commit(writer.url,"bounds",bytes(`marker-${n}`),BigInt(n)),201);
    await stop(writer.process);
    for(const n of [4n,16n,1n<<64n])await s3.send(new PutObjectCommand({Bucket:b,Key:key(n),Body:new Uint8Array()}));
    // Empty sentinels sort before published entries. Ignore conditional reads to exercise length-based detection too.
    // Without a recovery anchor, LIST is the documented way to find the tail.
    const reads:{method:string;url:URL}[]=[];
    const proxy=relay((request,response)=>{reads.push({method:request.method,url:new URL(request.url)});return request.method==="HEAD"&&response.status===304?new Response(null,{status:200,headers:{"content-length":"0"}}):response;});
    const restored=await server(b,proxy.url,unanchored);
    assert(reads.some(r=>r.method==="GET"&&r.url.searchParams.get("prefix")===objectKeys.timeline),"find the tail with an ordered LIST that skips sentinels");
    assert(!reads.some(r=>r.method==="HEAD"&&r.url.pathname.includes(`/${objectKeys.timeline}`)),"LIST gives the tail without exponential probes");
    assert.equal((await fullStatus(restored.url,"bounds")).latest?.viewpoint,2n);
    await status(await commit(restored.url,"bounds",bytes("marker-3"),3n),201);
    assert.equal(markerAt(await get(b,4n),"bounds").viewpoint,"3");await stop(restored.process);
  });
  await scenario("0zg1 timeline race", "bucket-derived empty sentinel validators, atomic conditional replacement, metadata-only ETag caveat, exclusive search bounds, wrapped empty markers, margin signs, and snapshot recovery (3/3)", async () => {
    const b=await bucket(),Key=epilogueKey(42n);
    const original=await s3.send(new PutObjectCommand({Bucket:b,Key,Body:new Uint8Array(),Metadata:{owner:"first"}}));assert.equal(original.ETag,emptyETag);
    const updated=await s3.send(new PutObjectCommand({Bucket:b,Key,Body:new Uint8Array(),IfMatch:original.ETag,Metadata:{owner:"second"}}));assert.equal(updated.ETag,original.ETag,"metadata-only changes do not supply a new fencing token");
    const outcomes=await Promise.all(Array.from({length:8},async(_,n)=>{try{await s3.send(new PutObjectCommand({Bucket:b,Key,Body:wrapEnvelope(bytes(`winner-${n}`),0),IfMatch:original.ETag}));return 200;}catch(e){return (e as {$metadata:{httpStatusCode:number}}).$metadata.httpStatusCode;}}));
    assert.equal(outcomes.filter(s=>s===200).length,1);assert.equal(outcomes.filter(s=>s===412).length,7);
    await assert.rejects(s3.send(new PutObjectCommand({Bucket:b,Key,Body:wrapEnvelope(bytes("stale"),0),IfMatch:original.ETag})),(e:any)=>e.$metadata.httpStatusCode===412);
  });
  // Flow Epilogue contents must never become a source of Basin state.
  await s3.send(new PutObjectCommand({Bucket:b,Key:`${objectKeys.userFlows}unrelated/epilogue/0`,Body:bytes("legacy, not a Timeline")}));
  const flowA = "0x-first", flowB = "__proto__";
  // The writer/observer pair and its stress history are shared by the next steps, so they run as one scenario.
  await scenario("0zg1 timeline race", "Flow isolation, stress, and replay with a shared writer and observer", async () => {
  const trace: {method:string;url:URL}[] = [];
  const traced = relay((r,response)=>{ trace.push({method:r.method,url:new URL(r.url)}); return response; });
  let writer = await server(b,traced.url);
  const observer = await server(b,traced.url);

  await scenario("0zg1 timeline race", "Flow isolation, validation, prototype-safe ids, and live Timeline refresh", async () => {
    const name=await bucket(),app=await server(name,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const node:HeapNode={auth:[0,0,bytes("flow-id-case-test")],length:1,edges:[]};
    const flowIds=vectors<{normalized:[string,string][];maxLength:number;invalid:string[]}>("flow-ids");
    const [mixed,canonical]=flowIds.normalized[0]!;
    await status(await reserveHeap(app.url,mixed,0n,[node]),200);
    await assertManifestRange(name,1n); // Ingestion-only entries also carry a manifest.
    await status(await commit(app.url,canonical,a,0n),201);
    assert.equal((await fullStatus(app.url,mixed)).latest?.viewpoint,0n);
    await mismatch(await commit(app.url,mixed,a,0n),1n);
    await status(await reserveHeap(app.url,mixed,0n,[node]),409);
    const longest="A".repeat(flowIds.maxLength);
    const longestResponse=await commit(app.url,longest,a,0n);await status(longestResponse.clone(),201);
    const portableTip=parse<CommitResponse>(await longestResponse.text()).timelines.basin.milestone;
    assert.equal((await fullStatus(app.url,longest.toLowerCase())).latest?.viewpoint,0n);
    for(const invalid of [...flowIds.invalid,"a".repeat(flowIds.maxLength+1)]){
      await status(await commit(app.url,invalid,a,0n),400);
      await status(await reserveHeap(app.url,invalid,0n,[node]),400);
      await status(await fetch(`${app.url}/api/v0/epilogue/status?${new URLSearchParams({flow:invalid})}`),400);
    }
    await eventually(()=>basinBackup(name),v=>!!v&&v.milestone>=portableTip);
    const objects=(await s3.send(new ListObjectsV2Command({Bucket:name,Prefix:objectKeys.userFlows}))).Contents??[];
    assert(objects.some(o=>o.Key!.startsWith(`${objectKeys.userFlows}${canonical}/`)));
    assert(objects.some(o=>o.Key!.startsWith(`${objectKeys.userFlows}${longest.toLowerCase()}/`)));
    assert.deepEqual(Object.keys(await eventually(()=>flowRevisions(name),r=>Object.keys(r).length>=2)).sort(),[canonical,longest.toLowerCase()].sort());
    await stop(app.process);
    const restored=await server(name);assert.equal((await fullStatus(restored.url,mixed)).latest?.viewpoint,0n);await stop(restored.process);
    console.log("put of success: portable Flow IDs normalize across APIs and recovery, reject unsafe characters, and fit direct object keys at 160 characters");
  });
  assert.deepEqual(await epilogueStatus(writer.url,flowA),{latest:null});
  await mismatch(await commit(writer.url,flowA,a,1n),0n);
  for (const kind of ["missing-details","duplicate-details","missing-flow","nul-flow","long-flow","missing-blob","duplicate-blob","unknown-part","legacy-part","unknown-details","decimal","number","negative","missing-viewpoint","missing-digest","missing-edges","hex-digest","array-digest","wrong-digest","short-digest","long-digest","malformed-json","duplicate-property","unescaped-flow","invalid-base64"]) {
    const data = form(flowA,a,0n);
    const details: Record<string,unknown> = {flow:flowA,viewpoint:0n,sha384:sha384Bytes(a),edges:[]};
    if(kind==="missing-flow")delete details.flow;
    if(kind==="nul-flow")details.flow="x\0y";
    if(kind==="long-flow")details.flow="x".repeat(600);
    if(kind==="unknown-details")details.surprise=true;
    if(kind==="decimal")details.viewpoint="0";
    if(kind==="number")details.viewpoint=0;
    if(kind==="negative")details.viewpoint=-1n;
    if(kind==="missing-viewpoint")delete details.viewpoint;
    if(kind==="missing-digest")delete details.sha384;
    if(kind==="missing-edges")delete details.edges;
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
  const wire = JSON.parse(stringify({flow:flowA,viewpoint:1n,sha384:sha384Bytes(a),edges:[]}));
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

  const flows = ["red","blue","0","constructor"];
  const count = Number(process.env.STRESS_COMMITS ?? 1025);
  await Promise.all(flows.map(async(flow,i)=>{
    const n = Math.floor(count/flows.length)+(i<count%flows.length?1:0);
    if(n>0)receipts.set(flow,await stress(writer.url,flow,n,4));
  }));
  const total = [...receipts.values()].reduce((n,m)=>n+m.size,0);
  const keys:string[]=[];
  for await(const page of paginateListObjectsV2({client:s3,pageSize:137},{Bucket:b,Prefix:objectKeys.timeline})) keys.push(...(page.Contents??[]).map(o=>o.Key!));
  const eventCount=keys.length;
  assert.deepEqual(keys,Array.from({length:eventCount},(_,i)=>key(BigInt(i+1))).sort());
  assert.deepEqual(keys,Array.from({length:eventCount},(_,i)=>key(BigInt(eventCount-i))),"keys list newest Milestones first");
  assert.equal(fromKey(keys[0]),BigInt(eventCount),"lowest key is the latest Milestone");
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
    parent=entryDigest(payload);
  }
  assert.equal(seen,total);
  const database=`${artifacts}/typescript-recovered.turso`;writeFileSync(database,image);
  const inspector=spawn([`${root}/target/debug/examples/frame-fixture`,"--inspect",database],{cwd:root,stdout:"pipe",stderr:"inherit"});
  const materialized=await new Response(inspector.stdout).json() as {milestone:string;flows:Record<string,string>};
  assert.equal(await inspector.exited,0);assert.equal(materialized.milestone,String(eventCount));
  assert.deepEqual(materialized.flows,Object.fromEntries([...replayed].map(([flow,vp])=>[flow,String(vp)])));
  const all=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.userFlows}));
  assert.deepEqual(all.Contents?.map(o=>o.Key),[`${objectKeys.userFlows}unrelated/epilogue/0`],"background backup is disabled in this pipeline test");
  await stop(writer.process);
  const start=trace.length;
  writer=await server(b,traced.url);
  const startup=trace.slice(start);
  assert.equal(startup.filter(r=>r.method==="GET"&&r.url.searchParams.get("prefix")===objectKeys.timeline).length,1);
  assert.equal(startup.filter(r=>r.method==="GET"&&r.url.pathname.includes(`/${objectKeys.timeline}`)).length,eventCount,"replay the entire Timeline");
  for(const [flow,v] of replayed) assert.deepEqual(await epilogueStatus(writer.url,flow),{latest:{viewpoint:v}});
  assert(trace.some(r=>r.url.searchParams.get("prefix")===objectKeys.basinEpilogue),"read the Basin recovery anchor before writing");
  await accepted(writer.url,flowA,bytes("after recovery"),2n);
  await stop(writer.process);await stop(observer.process);
  passed("0zg2 turso reservoir", "N markers across N gapless Milestones; independent TS WAL ingestion, full replay, and minimum-key latest discovery");
  });

  for(let round=0;round<Number(process.env.RACE_ROUNDS??8);round++){
    await scenario("0zg1 timeline race", `real conditional Timeline races choose one winner; losers respond and exit (round=${round})`, async () => {
    const raceBucket=await bucket(); let armed=false,arrived=0;
    const gate=Promise.withResolvers<void>();
    const proxy=relay(async(r,response)=>{
      if(armed&&arrived<3&&r.method==="HEAD"&&new URL(r.url).pathname.endsWith(`/${key(1n)}`)){
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
    });
  }
  passed("0zg1 timeline race", "real conditional Timeline races choose one winner; losers respond and exit");

  // A real HTTP batch preserves ordered markers, and no success or status
  // escapes while its S3 write is still blocked before storage.
  let modernRoot:Uint8Array|null=null;
  // Isolated scenario runs start without the two-batch scenario's root, so
  // build an equivalent four-marker batch on demand.
  async function ensureModernRoot():Promise<Uint8Array>{
    if(modernRoot)return modernRoot;
    const rootBucket=await bucket();
    const app=await server(rootBucket,undefined,{BASINSYNC_BATCH_MAX:"4",BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const requests:Promise<Response>[]=[];
    for(let viewpoint=0;viewpoint<4;viewpoint++){
      const [pending]=await admit(app,()=>commit(app.url,"ordered-ok",bytes(`marker-${viewpoint}`),BigInt(viewpoint)));
      requests.push(pending);
    }
    for(const response of await Promise.all(requests))await status(response,201);
    modernRoot=await get(rootBucket,1n);await stop(app.process);
    return modernRoot;
  }
  for(const fail of [false,true]){
    await scenario("0zg2 turso reservoir", `two-batch real-route overlap, one ordered PUT, full-batch admission, durable status/mismatch barriers, and failed-publication recovery (fail=${fail})`, async () => {
    const batchBucket=await bucket();const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    let puts=0,active=0,peak=0;
    const proxy=relay(async(request,response)=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){
        active--;if(fail){assert.equal(response.status,200);await response.arrayBuffer();return new Response("durable reply lost",{status:503});}
      }
      return response;
    },async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){puts++;active++;peak=Math.max(peak,active);entered.resolve();await gate.promise;}});
    const app=await server(batchBucket,proxy.url,{BASINSYNC_BATCH_MAX:"4",BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const flow=`ordered-${fail?"lost":"ok"}`;let completed=0;
    const requests:Promise<Response>[]=[];
    for(let viewpoint=0;viewpoint<4;viewpoint++){
      const [pending]=await admit(app,()=>commit(app.url,flow,bytes(`marker-${viewpoint}`),BigInt(viewpoint)).then(r=>{completed++;return r}));
      requests.push(pending);
    }
    await timeout(entered.promise);
    assert.equal(completed,0);
    await assert.rejects(()=>get(batchBucket,1n),"batch is not stored yet");
    const [fifth]=await admit(app,()=>commit(app.url,flow,bytes("marker-4"),4n).then(r=>{completed++;return r}));
    requests.push(fifth);
    let statusFinished=false;
    const statusRequest=fetch(`${app.url}/api/v0/epilogue/status?flow=${flow}`).then(r=>{statusFinished=true;return r});
    await Bun.sleep(30);assert.equal(completed,0);assert.equal(statusFinished,false);
    gate.resolve();
    const results=await Promise.all(requests);
    for(let i=0;i<results.length;i++){
      const receipt=parse<CommitResponse|ApiError>(await results[i].clone().text());
      assert.equal(receipt.timelines.basin.milestone,fail?0n:(i<4?1n:2n),"stamp each batch only after its own publication");
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
    });
  }
  // Preparation advances one batch ahead; failed publication discards it.
  for(const fault of ["none","before","after"]){
    await scenario("0zg2 turso reservoir", `two-batch real-route overlap, one ordered PUT, full-batch admission, durable status/mismatch barriers, and failed-publication recovery (fault=${fault})`, async () => {
    const pipelineBucket=await bucket();const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    let puts=0,active=0,peak=0,completed=0;
    const proxy=relay(async(request,response)=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){
        active--;if(fault==="after"){assert.equal(response.status,200);await response.arrayBuffer();return new Response("durable reply lost",{status:503});}
      }
      return response;
    },async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){
      puts++;active++;peak=Math.max(peak,active);
      if(puts===1){entered.resolve();await gate.promise;}
      if(fault==="before"){active--;return new Response("not stored",{status:503});}
    }});
    const app=await server(pipelineBucket,proxy.url,{BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",RUST_LOG:"basinsync=debug"});
    const flow=`pipeline-${fault}`;
    const requests=[commit(app.url,flow,a,0n).then(r=>{completed++;return r})];
    await timeout(entered.promise);
    requests.push(commit(app.url,flow,a,1n).then(r=>{completed++;return r}));await reach(app,"batches",2);
    const [third]=await admit(app,()=>commit(app.url,flow,a,2n).then(r=>{completed++;return r}));requests.push(third);
    let statusDone=false;const latest=fetch(`${app.url}/api/v0/epilogue/status?flow=${flow}`).then(value=>{statusDone=true;return value;});
    await Bun.sleep(30);
    assert.equal(puts,1);assert.equal(completed,0);assert.equal(statusDone,false);
    assert.equal((await progress(app)).batches,2,"only two batches may prepare ahead of the publication gate");
    await assert.rejects(()=>get(pipelineBucket,2n));
    gate.resolve();
    const results=await Promise.all(requests);
    for(let i=0;i<results.length;i++){
      const receipt=parse<CommitResponse|ApiError>(await results[i].clone().text());
      assert.equal(receipt.timelines.basin.milestone,fault==="none"?BigInt(i+1):0n,"never report a speculative or uncertain batch as durable");
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
    });
  }
  for(const fail of [false,true]){
    await scenario("0zg2 turso reservoir", `two-batch real-route overlap, one ordered PUT, full-batch admission, durable status/mismatch barriers, and failed-publication recovery (fail=${fail})`, async () => {
    const mismatchBucket=await bucket();const second=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    let puts=0;
    const proxy=relay(async(request,response)=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)&&puts===2&&fail){await response.arrayBuffer();return new Response("second reply lost",{status:503});}
      return response;
    },async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)&&++puts===2){entered.resolve();await second.promise;}});
    const app=await server(mismatchBucket,proxy.url,{BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",RUST_LOG:"basinsync=debug"});
    await status(await commit(app.url,"deferred-mismatch",a,0n),201);
    const next=commit(app.url,"deferred-mismatch",a,1n);await timeout(entered.promise);
    let conflictDone=false;const conflict=commit(app.url,"deferred-mismatch",a,0n).then(r=>{conflictDone=true;return r});
    await reach(app,"prepared",3);
    let statusDone=false;const latest=fetch(`${app.url}/api/v0/epilogue/status?flow=deferred-mismatch`).then(r=>{statusDone=true;return r});
    await Bun.sleep(30);assert.equal(conflictDone,false);assert.equal(statusDone,false);
    second.resolve();await status(await next,fail?503:201);
    if(fail){await status(await conflict,503);await status(await latest,503);assert.equal(await timeout(app.process.exited),1);}
    else{await mismatch(await conflict,2n);assert.deepEqual(positions(parse(await (await latest).text())),{latest:{viewpoint:1n}});await stop(app.process);}
    assert.equal(puts,2,"mismatch-only work must not create an event");await proxy.service.stop(true);
    });
  }
  await scenario("0zg2 turso reservoir", "two-batch real-route overlap, one ordered PUT, full-batch admission, durable status/mismatch barriers, and failed-publication recovery", async () => {
    const full=await bucket();const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let puts=0;
    const proxy=relay((_r,response)=>response,async r=>{if(r.method==="PUT"&&new URL(r.url).pathname.includes(`/${objectKeys.timeline}`)&&++puts===1){entered.resolve();await gate.promise;}});
    const app=await server(full,proxy.url,{BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const first=Array.from({length:32},(_,n)=>commit(app.url,`full-${n}`,a,0n));await timeout(entered.promise);
    const next=Array.from({length:32},(_,n)=>commit(app.url,`full-${n+32}`,a,0n));await reach(app,"batches",2);
    assert.equal(puts,1);gate.resolve();for(const result of await Promise.all([...first,...next]))await status(result,201);
    assert.equal(entriesAt(await get(full,1n)).length,32);assert.equal(entriesAt(await get(full,2n)).length,32);
    await stop(app.process);await proxy.service.stop(true);
  });
  // Byte bounds flush a batch before accepting another large request.
  await scenario("0zg2 turso reservoir", "real-route ordered batches, durable status, count/byte bounds, slow bodies, disconnects, queued failure rejection, and WAL startup integrity (1/3)", async () => {
    const limited=await bucket();const app=await server(limited,endpoint,{BASINSYNC_BATCH_MAX:"32",BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const large=new Uint8Array(5*1024*1024).fill(123);
    const [first]=await admit(app,()=>commit(app.url,"large-a",large,0n));
    const [second]=await admit(app,()=>commit(app.url,"large-b",large,0n));
    await status(await first,201);await status(await second,201);
    assert.equal(entriesAt(await get(limited,1n)).length,1);assert.equal(entriesAt(await get(limited,2n)).length,1);
    await stop(app.process);
  });
  // Slow form bodies consume admission slots, never the worker's status queue.
  await scenario("0zg2 turso reservoir", "real-route ordered batches, durable status, count/byte bounds, slow bodies, disconnects, queued failure rejection, and WAL startup integrity (2/3)", async () => {
    const idle=await bucket(),app=await server(idle);const port=Number(new URL(app.url).port);
    const sockets=await Promise.all(Array.from({length:64},()=>new Promise<ReturnType<typeof createConnection>>((yes,no)=>{
      const socket=createConnection({host:"127.0.0.1",port},()=>{socket.write(`PUT /api/v0/epilogue HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: 1024\r\n\r\n`);yes(socket)});socket.once("error",no);
    })));
    try{await Bun.sleep(30);assert.deepEqual(await timeout(epilogueStatus(app.url,"idle"),3000),{latest:null})}finally{for(const socket of sockets)socket.destroy()}
    await status(await commit(app.url,"idle",a,0n),201);await stop(app.process);
  });
  // Dropping an HTTP caller after admission does not cancel its owned batch.
  await scenario("0zg2 turso reservoir", "real-route ordered batches, durable status, count/byte bounds, slow bodies, disconnects, queued failure rejection, and WAL startup integrity (3/3)", async () => {
    const disconnected=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    const proxy=relay((_r,response)=>response,async r=>{if(r.method==="PUT"&&new URL(r.url).pathname.includes(`/${objectKeys.timeline}`)){entered.resolve();await gate.promise}});
    const app=await server(disconnected,proxy.url,{BASINSYNC_BATCH_MAX:"1",RUST_LOG:"basinsync=debug"});
    const abort=new AbortController();
    const [request]=await admit(app,()=>fetch(`${app.url}/api/v0/epilogue`,{method:"PUT",body:form("disconnected",a,0n),signal:abort.signal}));
    await timeout(entered.promise);abort.abort();await assert.rejects(request);gate.resolve();
    assert.deepEqual(await epilogueStatus(app.url,"disconnected"),{latest:{viewpoint:0n}});
    await status(await commit(app.url,"disconnected",a,1n),201);await stop(app.process);await proxy.service.stop(true);
  });
  for(const fault of ["version","format","parent","bootstrap","wal","logical","command-order"]){
    await scenario("0zg2 turso reservoir", `JS-to-Rust replay, malformed-event rejection, and ambiguous Timeline PUT recovery without retries (fault=${fault})`, async () => {
    const vector=eventTuples(await ensureModernRoot()) as any[];
    const delta=vector.at(-1)[3].turso["default.turso"];
    if(fault==="version")delta.version="incompatible";
    if(fault==="format")delta.physical.format="unknown";
    if(fault==="parent")delta.physical.parent="00".repeat(48);
    if(fault==="bootstrap")delta.physical.base_sha384="00".repeat(48);
    if(fault==="wal")delta.physical.segments[0][56]^=1;
    if(fault==="logical")delta.logical.frames[0][0]^=1;
    if(fault==="command-order")vector.reverse();
    const fixture=await bucket();await seed(fixture,1n,encodeTuples(vector));await badStartup(fixture);
    });
  }

  // Capture real Turso frames, then re-encode their event independently in JS.
  // Legacy single-tuple events (`{markers, deltas}` with physical pages) predate
  // the documented layout, and only this repository's server reads them.
  if(!Bun.env.BASINSYNC_SERVER){
  await scenario("0zg2 turso reservoir", "legacy single-tuple event replay and malformed legacy events", async () => {
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
  ];
  for(const fixture of invalid)await badStartup(await fixture());
  });
  }
  // Malformed documented events stop startup; an ambiguous Timeline PUT is
  // recovered from the bucket, never retried.
  await scenario("0zg2 turso reservoir", "JS-to-Rust replay, malformed-event rejection, and ambiguous Timeline PUT recovery without retries", async () => {
  const modern=await ensureModernRoot();
  const mutated=(change:(tuples:any[])=>void)=>{const tuples=eventTuples(modern) as any[];change(tuples);return encodeTuples(tuples);};
  const first=(tuples:any[])=>tuples[0][3].markers["ordered-ok"];
  const invalid: (()=>Promise<string>)[] = [
    async()=>{const b=await bucket();await s3.send(new PutObjectCommand({Bucket:b,Key:`${objectKeys.timeline}0`,Body:a}));return b},
    async()=>{const b=await bucket();await seed(b,2n,modern);return b},
    async()=>{const b=await bucket();await seed(b,1n,mutated(t=>{first(t).sha384="00".repeat(48);}));return b},
    async()=>{const b=await bucket();await seed(b,1n,mutated(t=>{first(t).viewpoint="18446744073709551616";}));return b},
    async()=>{const b=await bucket();await seed(b,1n,flexEncode([["wrong","command",{}]]));return b},
    ...["#species", Symbol.for("species"), Symbol.iterator, new TextEncoder().encode("#species"),
      Array.from(new TextEncoder().encode("#species")),
    ].map(tag=>async()=>{const b=await bucket();await seed(b,1n,mutated(t=>{t[0][0]=tag;}));return b}),
  ];
  for(const fixture of invalid)await badStartup(await fixture());

  const uncertain=await bucket();let puts=0;
  const faulty=relay(async(r,response)=>{
    if(r.method==="PUT"&&new URL(r.url).pathname.includes(`/${objectKeys.timeline}`)&&new URL(r.url).pathname.includes(`/${objectKeys.timeline}`)) {puts++;assert.equal(response.status,200);await response.arrayBuffer();return new Response("lost durable reply",{status:503})}
    return response;
  });
  const failed=await server(uncertain,faulty.url);
  await status(await commit(failed.url,"f",a,0n),503);
  assert.equal(await timeout(failed.process.exited),1);assert.equal(puts,1);
  const recovered=await server(uncertain);
  assert.deepEqual(await epilogueStatus(recovered.url,"f"),{latest:{viewpoint:0n}});
  await status(await commit(recovered.url,"f",a,1n),201);
  await stop(recovered.process);
  });
  // Paired database backup graphs, blocked image uploads, root interruption,
  // immutable prefix reconstruction, and graph-only recovery are exercised in
  // kernel-backup-integration.ts. UserSpace behavior below uses the same roots.
  // A GET capability exposes precisely one marker, even while its event also
  // contains other Flows, older markers, and database pages.
  await scenario("0zg3 backup recovery", "signed blob-only Range capabilities, empty markers, downstream URL reuse, persistent locations, and snapshot-plus-suffix recovery", async () => {
    const b=await bucket();
    const app=await server(b,endpoint,{BASINSYNC_BATCH_MAX:"4",BASINSYNC_BATCH_WAIT_MS:"1000",RUST_LOG:"basinsync=debug"});
    const target=new Uint8Array(65536);for(let n=0;n<target.length;n++)target[n]=n%251;
    const inputs:[string,Uint8Array,bigint][]=[["public",bytes("old public marker"),0n],["private",bytes("PRIVATE: must never escape through the public capability"),0n],["public",target,1n],["empty",new Uint8Array(),0n]];
    const requests:Promise<Response>[]=[];for(const [flow,blob,vp] of inputs){const [pending]=await admit(app,()=>commit(app.url,flow,blob,vp));requests.push(pending);}
    for(const response of await Promise.all(requests))await status(response,201);
    const stored=await get(b,1n),ranges=rangesAt(stored),range=ranges.find(r=>r.flow==="public"&&r.marker.viewpoint==="1")!;
    await assertManifestRange(b,1n,stored);
    let eventEnd=stored.length,skipped=0,outerBytes:Uint8Array;
    for(;;){
      const footer=await s3.send(new GetObjectCommand({Bucket:b,Key:key(1n),Range:`bytes=${eventEnd-8}-${eventEnd-1}`}));
      outerBytes=await footer.Body!.transformToByteArray();assert.equal(outerBytes.length,8);
      if(outerBytes[4]>>5!==6)break;
      const length=new DataView(outerBytes.buffer,outerBytes.byteOffset,8).getUint32(0,true),alignment=2**(outerBytes[4]&31);
      eventEnd-=Math.ceil((length+16)/alignment)*alignment;skipped++;
    }
    assert.equal(outerBytes[4]>>5,4);
    const messageLength=new DataView(outerBytes.buffer,outerBytes.byteOffset,8).getUint32(0,true);
    const outerAlignment=2**(outerBytes[4]&31),outerSpan=Math.ceil((messageLength+16)/outerAlignment)*outerAlignment;
    assert.equal(outerAlignment,8);
    let end=eventEnd-outerSpan+8+messageLength,query:any[];
    for(;;){
      const footer=await s3.send(new GetObjectCommand({Bucket:b,Key:key(1n),Range:`bytes=${end-8}-${end-1}`}));
      const tailBytes=await footer.Body!.transformToByteArray();assert.equal(tailBytes.length,8);
      const contentLength=new DataView(tailBytes.buffer,tailBytes.byteOffset,tailBytes.byteLength).getUint32(0,true);
      const alignment=2**(tailBytes[4]&31);assert.equal(alignment,8);
      const span=Math.ceil((contentLength+16)/alignment)*alignment;
      if(tailBytes[4]>>5===6){end-=span;skipped++;continue;}
      const last=await s3.send(new GetObjectCommand({Bucket:b,Key:key(1n),Range:`bytes=${end-span}-${end-1}`}));
      const manifestBytes=await last.Body!.transformToByteArray(),manifest=previousEnvelope(manifestBytes,manifestBytes.length);
      query=toObject(new Uint8Array(manifest.content)) as any[];break;
    }
    assert.equal(skipped,1);assert.equal(query[2],"sts/0/databasin/rangemanifest");
    const frames=commandFrames(stored);for(const frame of frames){assert.equal(frame.start%8,0);assert.equal(frame.end%8,0);}
    assert.deepEqual(Object.keys(query[3].envelopes),frames.slice(0,-1).map(e=>lex(BigInt(e.end-8))));
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
    // marker is stored, then it uses the message range in the Flow's envelope.
    const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    const proxy=relay((_,response)=>response,async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.userFlows}`)){entered.resolve();await gate.promise;}});
    const copying=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});await timeout(entered.promise);
    assert.deepEqual(await latestBlob((await fullStatus(copying.url,"public")).latest!),target);
    gate.resolve();
    await eventually(()=>flowBlob(b,"public",1n),blob=>blob!==null);
    const complete=await eventually(()=>fullStatus(copying.url,"public"),s=>!!s.latest?.url&&new URL(s.latest.url).pathname.includes(`/${objectKeys.userFlows}`));
    assert(new URL(complete.latest!.url!).pathname.endsWith(`/${await flowKey(b,"public",1n)}`));
    assert.deepEqual(complete.latest!.headers,{"If-Match":"*",Range:`bytes=8-${8+target.length-1}`});assert.deepEqual(await latestBlob(complete.latest!),target);
    assert.equal(new URL(complete.latest!.url!).searchParams.get("X-Amz-SignedHeaders"),"host;if-match;range");
    const unguarded=await fetch(complete.latest!.url!);assert(unguarded.status>=400,"a missing signed condition must fail authentication");await unguarded.arrayBuffer();
    assert(!("url" in (await fullStatus(copying.url,"empty")).latest!));
    const checkpoint=await eventually(()=>basinBackup(b),cp=>cp?.milestone===1n);assert(checkpoint);
    const path=`${artifacts}/ranges-backup.turso`;writeFileSync(path,checkpoint.blob);
    for(const item of ranges){
      const inspect=spawn([`${root}/target/debug/examples/frame-fixture`,"--locate",path,item.flow,item.marker.viewpoint],{cwd:root,stdout:"pipe",stderr:"inherit"});
      const row=await new Response(inspect.stdout).json();assert.equal(await inspect.exited,0);
      assert.deepEqual(row,{upstream:lex(1n),downstream:lex(BigInt(item.marker.viewpoint)),offset:item.offset,length:item.length,sha384:item.marker.sha384});
    }
    await stop(copying.process);
    const tail=await server(b);await status(await commit(tail.url,"public",bytes("after checkpoint"),2n),201);await stop(tail.process);
    const anchored=await server(b);const latest=(await fullStatus(anchored.url,"public")).latest!;
    assert.equal(latest.viewpoint,2n);assert(new URL(latest.url!).pathname.includes(`/${objectKeys.timeline}`));assert.deepEqual(await latestBlob(latest),bytes("after checkpoint"));await stop(anchored.process);
  });
  // Current observers need no LIST; a positive successor probe discovers the
  // Basin anchor before replay. Flow marker selection never lists its Epilogue.
  await scenario("0zg3 backup recovery", "latest-only status probes successors, discovers newer snapshots only when behind, and never lists Flow Epilogues", async () => {
    const b=await bucket(),reads:{method:string;url:URL}[]=[];
    const proxy=relay((request,response)=>{reads.push({method:request.method,url:new URL(request.url)});return response;});
    const observer=await server(b,proxy.url);
    async function checkedStatus(flow:string,advanced=false){
      reads.length=0;
      const state=await fullStatus(observer.url,flow);
      const lists=reads.filter(r=>r.url.searchParams.has("list-type"));
      assert(!lists.some(r=>r.url.searchParams.get("prefix")?.startsWith(objectKeys.userFlows)),"never list a Flow Epilogue");
      if(advanced){
        assert(lists.some(r=>r.url.searchParams.get("prefix")===objectKeys.basinEpilogue),"discover the latest Basin anchor after a positive probe");
        assert.equal(reads[0].method,"HEAD");assert(reads[0].url.pathname.includes(`/${objectKeys.timeline}`));
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
    const cp=await eventually(()=>basinBackup(b),cp=>cp?.milestone===5n);assert(cp);
    await stop(copying.process); // Settle maintenance before testing the absent-successor fast path.
    const suffixWriter=await server(b);
    assert.deepEqual(await flowBlob(b,"known",3n),bytes("fourth"));
    const stored=(await checkedStatus("known",true)).latest!;
    assert.equal(stored.viewpoint,3n);assert.deepEqual(stored.headers,{"If-Match":"*",Range:"bytes=8-13"});
    assert(!reads.some(r=>r.method==="GET"&&r.url.pathname.includes(`/${objectKeys.timeline}`)&&fromKey(r.url.pathname.slice(r.url.pathname.indexOf(objectKeys.timeline)))<=cp.milestone),"load the newer snapshot instead of replaying its covered prefix");
    assert.deepEqual(await latestBlob(stored),bytes("fourth"));
    assert.deepEqual((await checkedStatus("known")).latest?.headers,{"If-Match":"*",Range:"bytes=8-13"});
    await status(await commit(suffixWriter.url,"known",bytes("suffix"),4n),201);
    const suffix=(await checkedStatus("known",true)).latest!;
    assert.equal(suffix.viewpoint,4n);assert.deepEqual(await latestBlob(suffix),bytes("suffix"));
    assert.deepEqual(await checkedStatus("absent"),{latest:null});
    await stop(suffixWriter.process);await stop(observer.process);
  });
  // Probe freshness is Basin-wide; status cache hits never extend the window.
  await scenario("0zg1 timeline race", "bounded probe freshness, causal-reverse detection across instances, and durable response positions for writes, status, and errors", async () => {
    const b=await bucket(),reads:{method:string;url:URL}[]=[];
    const proxy=relay((request,response)=>{reads.push({method:request.method,url:new URL(request.url)});return response;});
    const observer=await server(b,proxy.url,{BASINSYNC_STATUS_PROBE_MAX_AGE_MS:"3000"});
    const writer=await server(b);
    function probes(){return reads.filter(r=>r.method==="HEAD"&&r.url.pathname.includes(`/${objectKeys.timeline}`));}
    reads.length=0;
    const initial=await fullStatus(observer.url,"external");
    assert.equal(initial.timelines.basin.milestone,0n);assert.deepEqual(payload(initial),{latest:null});
    assert.equal(probes().length,1,"first status probes immediately");
    const written=await commit(writer.url,"external",a,0n);
    const receipt=parse<CommitResponse>(await written.clone().text());
    assert.equal(receipt.timelines.basin.milestone,1n);await status(written,201);
    reads.length=0;
    const stale=await fullStatus(observer.url,"external");
    assert.deepEqual(payload(stale),{latest:null});
    assert(stale.timelines.basin.milestone<receipt.timelines.basin.milestone,"a different instance exposes its older causal prefix");
    assert.deepEqual(payload(await fullStatus(observer.url,"another-flow")),{latest:null});
    assert.equal(reads.length,0,"all Flows reuse the recent Basin check");
    await Bun.sleep(1600);
    assert.deepEqual(payload(await fullStatus(observer.url,"external")),{latest:null});
    assert.equal(reads.length,0,"cache hits do not probe");
    await Bun.sleep(1600);
    const refreshed=await fullStatus(observer.url,"external");
    assert.equal(refreshed.timelines.basin.milestone,1n);
    const caughtUp=refreshed.latest!;
    assert.equal(caughtUp.viewpoint,0n);assert(probes().length>0,"expiry probes and refreshes despite intervening cache hits");
    assert.deepEqual(await latestBlob(caughtUp),a);
    await status(await commit(writer.url,"external",bytes("external next"),1n),201);
    // A write must refresh even while status would accept the old check.
    reads.length=0;
    const localWrite=await commit(observer.url,"local",a,0n);
    assert.equal(parse<CommitResponse>(await localWrite.clone().text()).timelines.basin.milestone,3n);
    await status(localWrite,201);
    assert(reads.some(r=>r.url.searchParams.get("prefix")===objectKeys.basinEpilogue),"writes always discover the Basin anchor");
    reads.length=0;
    const local=await fullStatus(observer.url,"local");
    assert.equal(local.timelines.basin.milestone,3n);
    assert.equal(local.latest?.viewpoint,0n,"own acknowledged writes remain visible");
    assert.equal((await fullStatus(observer.url,"external")).latest?.viewpoint,1n,"write refresh also advances status state");
    assert.equal(probes().length,0,"a successful write refresh renews the check");
    const conflict=await commit(observer.url,"local",a,0n);
    assert.equal(parse<ViewpointMismatch>(await conflict.clone().text()).timelines.basin.milestone,3n);
    await mismatch(conflict,1n);
    const invalid=await fetch(`${observer.url}/api/v0/epilogue/status`);
    assert.equal(parse<ApiError>(await invalid.clone().text()).timelines.basin.milestone,3n);
    await status(invalid,400);
    await stop(writer.process);await stop(observer.process);
  });
  // Conditional sequence HEADs distinguish live entries from empty sentinels. Exercise both missing-key
  // responses, an endpoint ignoring conditions, and failures that must not look absent.
  for(const mode of ["native","missing-412","ignored","denied","unavailable"]){
    await scenario("0zg1 timeline race", `conditional reads, 304/412/404 probe compatibility, and fail-closed authorization/service errors (mode=${mode})`, async () => {
    const b=await bucket();let present=0,absent=0;
    const proxy=relay((request,response)=>{
      const url=new URL(request.url),object=url.pathname.split("/").slice(2).join("/");
      if(object&&["GET","HEAD"].includes(request.method))assert.equal(request.headers.get("if-match"),"*");
      if(request.method!=="HEAD"||!object)return response;
      const probe=url.pathname.includes(`/${objectKeys.timeline}`);
      if(probe){
        assert.equal(request.headers.get("if-none-match"),emptyETag);
        if(mode==="denied")return new Response(null,{status:403});
        if(mode==="unavailable")return new Response(null,{status:500});
        if(response.status===200){present++;if(mode==="ignored")return new Response(null,{status:200,headers:response.headers});}
      }
      if(response.status===404){absent++;if(mode==="missing-412")return new Response(null,{status:412});}
      return response;
    });
    const observer=await server(b,proxy.url);
    const initial=await fetch(`${observer.url}/api/v0/epilogue/status?flow=conditional`);
    if(mode==="denied"||mode==="unavailable"){
      await status(initial,503);assert.equal(await timeout(observer.process.exited),1);return;
    }
    await status(initial,200);
    const writer=await server(b);await status(await commit(writer.url,"conditional",a,0n),201);
    const found=await fullStatus(observer.url,"conditional");
    assert.equal(found.latest?.viewpoint,0n);assert.deepEqual(await latestBlob(found.latest!),a);
    assert(present>0&&absent>0,"exercise both branches of conditional existence search");
    await stop(writer.process);await stop(observer.process);
    });
  }
  passed("0zg1 timeline race", "conditional reads, 304/412/404 probe compatibility, and fail-closed authorization/service errors");
  // Heap staging journals derived identifiers, never authentication material.
  await scenario("0zg3 shallow heap", "shallow heap reservations, partial errors, length-bound first-writer uploads, both generations, retries, Viewpoint checks, snapshots, service limits, and no persisted tokens", async () => {
    const b=await bucket(),stateDir=`${artifacts}/heap-state`;
    const app=await server(b,endpoint,{BASINSYNC_DATA_DIR:stateDir});
    const flow="0x-staging",secret=bytes("client-only-heap-secret-44b5317c76db0c09"),emptySecret=bytes("client-only-empty-node-secret-d9a812f"),oversize=bytes("oversized-client-token-"+"x".repeat(64));
    const id=(token:Uint8Array,height=0)=>`n-${lex(~BigInt(height))}/v.${lex(0n)}/t.${lex(BigInt(token.length))}/d_${sha384(token)}`;
    const owner=(f:string,v:bigint)=>`_a_${f}/v.${lex(0n)}/e.${lex(v)}`;
    const node=(token=secret,length=7):HeapNode=>({auth:[0,0,token],length,edges:[]});
    async function reserved(response:Response){await status(response.clone(),200);return parse<HeapResponse>(await response.text());}
    async function inspectHeap(image:Uint8Array,token:Uint8Array,f=flow,v=0n){
      const path=`${artifacts}/heap-inspect.turso`;writeFileSync(path,image);
      const result=spawn([`${root}/target/debug/examples/frame-fixture`,"--heap",path,id(token),owner(f,v)],{cwd:root,stdout:"pipe",stderr:"inherit"});
      const row=await new Response(result.stdout).json();assert.equal(await result.exited,0);return row;
    }
    const input=[node(),{...node(),auth:[129,0,secret] as HeapNode["auth"]},{...node(),auth:[0,1,secret] as HeapNode["auth"]},{...node(),edges:["target"]} as unknown as HeapNode,node(oversize),node(),node(secret,8),node(emptySecret,0)];
    const response=await reserved(await reserveHeap(app.url,flow,0n,input));
    assert.equal(response.timelines.basin.milestone,1n);
    assert.deepEqual(Object.keys(response.results!),["0","5","7"]);
    assert.deepEqual(Object.keys(response.errors!),["1","2","3","4","6"]);
    assert.deepEqual(Object.values(response.errors!).map(e=>e.code),["height_limit","unsupported_version","invalid_node","token_limit","length_collision"]);
    const actions=response.results![0].actions,zero=response.results![7].actions;
    assert(actions.write&&actions.preview&&zero.write&&zero.preview);
    const revision = new URL(actions.write.url).pathname.split("/").at(-1)!;
    assert.match(revision,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert(new URL(actions.write.url).pathname.endsWith(`/${objectKeys.userHeap}young/${id(secret)}/${revision}`));
    assert(new URL(actions.read.url).pathname.endsWith(`/${objectKeys.userHeap}old/${id(secret)}/${revision}`));
    assert.equal(new URL(actions.write.url).searchParams.get("X-Amz-SignedHeaders"),"content-length;host;if-none-match");
    assert.deepEqual(actions.write.headers,{"Content-Length":"7","If-None-Match":"*"});
    for(const action of [actions.preview,actions.read]){assert.equal(action.headers["If-Match"],"*");const r=await fetch(action.url,{headers:action.headers});assert([404,412].includes(r.status));await r.arrayBuffer();}
    const first=await get(b,1n),tuples=eventTuples(first);
    assert.equal(tuples.length,1);assert.equal(tuples[0][2],"sts/0/databasin/ingestturso");
    assert.equal(envelopes(first).length,2);assert.equal(commandFrames(first).length,2);assert.deepEqual(envelopes(first).at(-1)!.content,new Uint8Array(8));assert.deepEqual(rangesAt(first),[]);
    const delta=deltasAt(first).turso["default.turso"] as WalDelta;
    let image=ingestWal(delta.logical.base!,delta.physical.segments);
    const original=await inspectHeap(image,secret);assert.equal(original.length,7);assert.equal(original.etag,"");assert.equal(original.promoted,"");assert(original.retained);assert(Number.isFinite(Date.parse(original.reserved)));
    const badWrites:[Record<string,string>,Uint8Array][]=[[{"Content-Length":"7"},bytes("payload")],[{...actions.write.headers,"Content-Length":"8"},bytes("payload!")]];
    for(const [headers,body] of badWrites){
      const rejected:Response=await fetch(actions.write.url,{method:"PUT",headers,body:new Blob([new Uint8Array(body)])});assert(rejected.status>=400,"changing length or omitting the write condition invalidates the signature");await rejected.arrayBuffer();
    }
    assert.equal((await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:`${objectKeys.userHeap}young/`}))).KeyCount,0);
    const put=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:bytes("payload")});assert(put.ok,await put.text());
    const duplicate=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:bytes("changed")});assert.equal(duplicate.status,412);await duplicate.arrayBuffer();
    const preview=await fetch(actions.preview.url,{headers:actions.preview.headers});assert.equal(preview.status,200);assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),bytes("payload"));
    const emptyPut=await fetch(zero.write.url,{method:"PUT",headers:zero.write.headers,body:new Uint8Array()});assert(emptyPut.ok,await emptyPut.text());
    const emptyGet=await fetch(zero.preview.url,{headers:zero.preview.headers});assert.equal(emptyGet.status,200);assert.equal((await emptyGet.arrayBuffer()).byteLength,0);
    await s3.send(new PutObjectCommand({Bucket:b,Key:`${objectKeys.userHeap}old/${id(secret)}/${revision}`,Body:bytes("payload")}));
    const old=await fetch(actions.read.url,{headers:actions.read.headers});assert.equal(old.status,200);assert.deepEqual(new Uint8Array(await old.arrayBuffer()),bytes("payload"));
    const retry=await reserved(await reserveHeap(app.url,flow,0n,[node(),node()]));assert.equal(retry.errors,null);assert.deepEqual(Object.keys(retry.results!),["0","1"]);
    const other=await reserved(await reserveHeap(app.url,"another-flow",0n,[node()]));assert.equal(other.errors,null);
    await mismatch(await reserveHeap(app.url,flow,1n,[node()]),0n);
    await status(await commit(app.url,flow,bytes("root marker"),0n),201);
    await mismatch(await reserveHeap(app.url,flow,0n,[node()]),1n);
    await mismatch(await reserveHeap(app.url,flow,2n,[node()]),1n);
    await reserved(await reserveHeap(app.url,flow,1n,[node()]));
    const invalid=await reserved(await reserveHeap(app.url,flow,1n,[{...node(),auth:[0,0,"client-only-malformed-auth-secret"]} as unknown as HeapNode]));
    assert.equal(invalid.results,null);assert.equal(invalid.errors![0].code,"invalid_node");assert.equal(invalid.timelines.basin.milestone,5n);
    const empty=await reserved(await reserveHeap(app.url,flow,1n,[]));assert.equal(empty.errors,null);assert.equal(empty.results,null);assert.equal(empty.timelines.basin.milestone,5n);
    await stop(app.process);
    const copying=await server(b,endpoint,{BASINSYNC_DATA_DIR:stateDir,BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const cp=await eventually(()=>basinBackup(b),value=>value?.milestone===5n);assert(cp);
    for(let m=2n;m<=5n;m++)image=ingestWal(image,(deltasAt(await get(b,m)).turso["default.turso"] as WalDelta).physical.segments);
    assert.deepEqual(cp.blob,image,"reservations and markers share physical recovery and snapshotting");
    assert.deepEqual(await inspectHeap(cp.blob,secret),original,"retries retain original node metadata");
    assert((await inspectHeap(cp.blob,secret,"another-flow")).retained);assert((await inspectHeap(cp.blob,secret,flow,1n)).retained);
    await stop(copying.process);
    const restored=await server(b,endpoint,{BASINSYNC_DATA_DIR:stateDir});
    const beforeRetry=(await fullStatus(restored.url,flow)).timelines.basin.milestone;
    const replayed=await reserved(await reserveHeap(restored.url,flow,1n,[node()]));assert.equal(replayed.errors,null);assert.equal(replayed.timelines.basin.milestone,beforeRetry+1n);
    await stop(restored.process);
    const secrets=[secret,emptySecret,oversize,bytes("client-only-malformed-auth-secret")];
    function assertNoTokens(contents:Uint8Array){const value=Buffer.from(contents);for(const token of secrets){assert(!value.includes(token),"raw token persisted");assert(!value.includes(Buffer.from(stringify(token).slice(1,-1))),"JSON0 token persisted");}}
    for await(const page of paginateListObjectsV2({client:s3},{Bucket:b}))for(const object of page.Contents??[]){assertNoTokens(bytes(object.Key!));const stored=await s3.send(new GetObjectCommand({Bucket:b,Key:object.Key!}));assertNoTokens(await stored.Body!.transformToByteArray());}
    function scan(dir:string){for(const name of readdirSync(dir)){const path=resolve(dir,name);if(statSync(path).isDirectory())scan(path);else assertNoTokens(readFileSync(path));}}
    scan(stateDir);for(const log of [app.log,copying.log,restored.log])assertNoTokens(readFileSync(log));
    const smallBucket=await bucket(),limited=await server(smallBucket,endpoint,{BASINSYNC_HEAP_MAX_HEIGHT:"0",BASINSYNC_HEAP_MAX_TOKEN_BYTES:"4"});
    const limits=await reserved(await reserveHeap(limited.url,"limits",0n,[node(bytes("12345")),{...node(bytes("1234")),auth:[1,0,bytes("1234")]},node(bytes("1234"))]));
    assert.equal(limits.errors![0].code,"token_limit");assert.equal(limits.errors![1].code,"height_limit");assert(limits.results![2]);await stop(limited.process);
  });
  // Reservation and commit batches share the two-slot publication pipeline.
  for(const fault of ["none","before","after"]){
    await scenario("0zg3 shallow heap", `pipelined reservation/commit durability, ambiguous reservation recovery, and competing reservers (fault=${fault})`, async () => {
    const b=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let puts=0,done=false;
    const proxy=relay(async(request,response)=>{
      if(fault==="after"&&request.method==="PUT"&&new URL(request.url).pathname.endsWith(`/${key(1n)}`)){await response.arrayBuffer();return new Response("reply lost",{status:503});}return response;
    },async request=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){puts++;if(puts===1){entered.resolve();await gate.promise;if(fault==="before")return new Response("not stored",{status:503});}}
    });
    const app=await server(b,proxy.url,{BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",RUST_LOG:"basinsync=debug"});
    const input:HeapNode={auth:[0,0,bytes("pipeline-client-only-access-token")],length:0,edges:[]};
    const reservation=reserveHeap(app.url,"pipelined-heap",0n,[input]).then(r=>{done=true;return r});await timeout(entered.promise);
    const following=commit(app.url,"pipelined-heap",bytes("root"),0n);await reach(app,"batches",2);
    assert.equal(done,false,"do not release actions before reservation durability");assert.equal(puts,1,"prepared successor must not upload early");
    gate.resolve();const first=await reservation;
    if(fault==="none"){
      await status(first.clone(),200);assert.equal(parse<HeapResponse>(await first.text()).timelines.basin.milestone,1n);
      const second=await following;await status(second.clone(),201);assert.equal(parse<CommitResponse>(await second.text()).timelines.basin.milestone,2n);await stop(app.process);
    }else{
      const error=parse<ApiError>(await first.clone().text());assert.equal(error.timelines.basin.milestone,0n);assert(!("results" in error));await status(first,503);
      await status(await following,503);assert.equal(await timeout(app.process.exited),1);assert.equal(puts,1);
      const restored=await server(b);const retry=await reserveHeap(restored.url,"pipelined-heap",0n,[input]);await status(retry.clone(),200);
      assert.equal(parse<HeapResponse>(await retry.text()).timelines.basin.milestone,fault==="after"?2n:1n);await stop(restored.process);
    }
    });
  }
  // Concurrent reservers arbitrate with the same conditional Timeline append.
  await scenario("0zg3 shallow heap", "pipelined reservation/commit durability, ambiguous reservation recovery, and competing reservers", async () => {
    const b=await bucket(),gate=Promise.withResolvers<void>();let puts=0;
    const proxy=relay((_,response)=>response,async request=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){if(++puts===2)gate.resolve();await gate.promise;}
    });
    const apps=await Promise.all([server(b,proxy.url),server(b,proxy.url)]);
    const nodes:HeapNode[]=[{auth:[0,0,bytes("shared-client-only-reservation-secret")],length:0,edges:[]}];
    const results=await timeout(Promise.all(apps.map((app,i)=>reserveHeap(app.url,`heap-race-${i}`,0n,nodes))));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,503]);
    for(let i=0;i<results.length;i++)await status(results[i],results[i].status);
    await Promise.all(apps.map(app=>stop(app.process)));
    const restored=await server(b);for(let i=0;i<2;i++)await status(await reserveHeap(restored.url,`heap-race-${i}`,0n,nodes),200);
    assert.equal((await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.timeline}))).KeyCount,3);await stop(restored.process);
  });
  // Independent workers may DELETE the same old revision; neither can erase its replacement.
  await scenario("0zg4 async cleanup", "bounded deferred cleanup, shared retainers, foreground progress during DELETE, revision-safe reuse, late-upload dust, and durable restart recovery", async () => {
    const b=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let held=false;
    const proxy=relay((_,response)=>response,async request=>{
      if(request.method==="DELETE"&&new URL(request.url).pathname.includes(`/${objectKeys.userHeap}young/`)){held=true;entered.resolve();await gate.promise;}
    });
    const options={BASINSYNC_CLEANUP_INTERVAL_MS:"15",BASINSYNC_SWEEP_BATCH_SIZE:"1",BASINSYNC_SWEEP_EDGE_BATCH_SIZE:"1",BASINSYNC_ERASE_BATCH_SIZE:"1",BASINSYNC_ERASE_CONCURRENCY:"1"};
    const app=await server(b,proxy.url,options),secret=bytes("cleanup-reusable-token"),input:HeapNode={auth:[0,0,secret],length:4,edges:[]};
    const reserve=async(url:string,flow:string)=>{const r=await reserveHeap(url,flow,0n,[input]);await status(r.clone(),200);return parse<HeapResponse>(await r.text());};
    const initial=await reserve(app.url,"first"),actions=initial.results![0].actions;assert(actions.write&&actions.preview);
    const oldKey=new URL(actions.write.url).pathname.slice(b.length+2);
    const put=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:bytes("same")});assert(put.ok,await put.text());
    const shared=await reserve(app.url,"shared");assert.equal(new URL(shared.results![0].actions.preview!.url).pathname,new URL(actions.preview.url).pathname);
    const firstCommit=await commit(app.url,"first",bytes("marker"),0n);await status(firstCommit.clone(),201);
    const firstMilestone=parse<CommitResponse>(await firstCommit.text()).timelines.basin.milestone;
    await eventually(()=>fullStatus(app.url,"first"),response=>response.timelines.basin.milestone>firstMilestone);
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
    const objects=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:`${objectKeys.userHeap}young/`}));assert.equal(objects.KeyCount,2);assert(objects.Contents!.some(o=>o.Key===oldKey));
    const restored=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const again=await reserve(restored.url,"reuse");assert.equal(new URL(again.results![0].actions.preview!.url).pathname,new URL(next.preview.url).pathname);
    const target=again.timelines.basin.milestone;
    const cp=await eventually(()=>basinBackup(b),cp=>!!cp&&cp.milestone>=target);assert(cp);
    let image:Uint8Array|undefined;
    for(let m=1n;m<=cp.milestone;m++){const delta=deltasAt(await get(b,m)).turso["default.turso"] as WalDelta;image=ingestWal(image??delta.logical.base!,delta.physical.segments);}
    assert.deepEqual(cp.blob,image,"cleanup and revision reuse survive physical replay and snapshot recovery");
    await stop(restored.process);
  });
  for(const fault of ["before","after"]){
    await scenario("0zg5 deep heap", `deep node DAGs, cached conditional HEADs in both generations, immutable child sets, degree/height limits, nonblocking verification, revision races, bounded recursive reclamation, and snapshot replay (fault=${fault})`, async () => {
    const b=await bucket();let deletes=0,failed=false;const sweeps=new WeakSet<Request>();
    const isSweep=(request:Request)=>request.method==="PUT"&&new URL(request.url).pathname.endsWith(`/${key(3n)}`);
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
    });
  }

  await scenario("0zg5 deep heap", "deep node DAGs, cached conditional HEADs in both generations, immutable child sets, degree/height limits, nonblocking verification, revision races, bounded recursive reclamation, and snapshot replay (1/2)", async () => {
    const b=await bucket(),flows=new Set<string>(),heads=new Map<string,number>();let mode="normal",target="",rootId="",checkedDeletion=false;
    const slow=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let hold=false;
    async function image(){
      const moments=(await committedKeys(s3,b,objectKeys.timeline)).map(fromKey).sort((a,b)=>a<b?-1:1);
      let bytes:Uint8Array|undefined;
      for(const m of moments){const d=deltasAt(await get(b,m)).turso["default.turso"] as WalDelta;bytes=ingestWal(bytes??d.logical.base!,d.physical.segments);}
      assert(bytes);return bytes;
    }
    async function inspect(bytes:Uint8Array,id?:string){
      const path=`${artifacts}/deep-${serial++}.turso`;writeFileSync(path,bytes);
      const args=id?["--heap",path,id,"unused"]:["--graph",path];
      const p=spawn([`${root}/target/debug/examples/frame-fixture`,...args],{cwd:root,stdout:"pipe",stderr:"inherit"});
      const row=await new Response(p.stdout).json();assert.equal(await p.exited,0);return row;
    }
    const proxy=relay((_,response)=>response,async request=>{
      const path=new URL(request.url).pathname;
      if(request.method==="HEAD"&&path.includes(`/${objectKeys.userHeap}`)){
        assert.equal(request.headers.get("if-match"),"*");heads.set(path,(heads.get(path)??0)+1);
        if(path===target&&mode==="denied")return new Response(null,{status:403});
        if(path===target&&mode==="unavailable")return new Response(null,{status:500});
        if(path===target&&hold){entered.resolve();await slow.promise;}
      }
      if(request.method==="DELETE"&&rootId&&path.includes(`/${rootId}/`)){
        const row=await inspect(await image(),rootId);assert.deepEqual(row.children,[]);assert(row.freed);checkedDeletion=true;
      }
    });
    const app=await server(b,proxy.url);
    const token=(name:string)=>bytes(`deep-node-auth-private-${name}`);
    const leaf=(name:string):HeapNode=>({auth:[0,0,token(name)],length:1,edges:[]});
    const parent=(height:number,name:string,children:HeapNode[]):HeapNode=>({auth:[height,0,token(name)],length:1,edges:children.map(n=>({auth:n.auth}))});
    const reserve=async(flow:string,nodes:HeapNode[])=>{const r=await reserveHeap(app.url,flow,0n,nodes);await status(r.clone(),200);const body=parse<HeapResponse>(await r.text());if(body.results)flows.add(flow);return body;};
    const upload=async(a:NonNullable<HeapResponse["results"]>[number]["actions"])=>{assert(a.write);const r=await fetch(a.write.url,{method:"PUT",headers:a.write.headers,body:bytes("x")});assert(r.ok,await r.text());};
    const a=leaf("a"),c=leaf("c"),shared=leaf("shared");
    const leaves=await reserve("leaves",[a,shared,c]);for(const result of Object.values(leaves.results!))await upload(result.actions);
    const left=parent(1,"left",[a,shared]),right=parent(1,"right",[shared,c]);
    const leftResult=await reserve("deep",[left]);await upload(leftResult.results![0].actions);
    const rightResult=await reserve("deep",[right]);await upload(rightResult.results![0].actions);
    const sharedPath=new URL(leaves.results![1].actions.preview!.url).pathname;assert.equal(heads.get(sharedPath),1,"ETag cache avoids a second child HEAD");
    const rootNode=parent(2,"root",[left,right]),rootResult=await reserve("deep",[rootNode]);await upload(rootResult.results![0].actions);
    const rootPath=new URL(rootResult.results![0].actions.preview!.url).pathname;rootId=rootPath.split(`/${objectKeys.userHeap}young/`)[1].split("/").slice(0,-1).join("/");
    const repeat=await reserve("sharing",[{...left,edges:[...left.edges].reverse().concat(left.edges[0])}]);assert(repeat.results);assert.equal(new URL(repeat.results![0].actions.preview!.url).pathname,new URL(leftResult.results![0].actions.preview!.url).pathname);
    assert.equal((await reserve("deep",[{...left,length:2}])).errors![0].code,"length_collision");
    assert.equal((await reserve("deep",[{...left,edges:[left.edges[0]]}])).errors![0].code,"edges_collision");
    assert.equal((await reserve("deep",[parent(1,"bad-height",[left])])).errors![0].code,"invalid_height");
    assert.equal((await reserve("deep",[parent(1,"unknown",[leaf("unknown-child")])])).errors![0].code,"child_unknown");
    const missing=leaf("missing");const missingResult=await reserve("leaves",[missing]);
    const needsMissing=parent(1,"needs-missing",[missing]);assert.equal((await reserve("deep",[needsMissing])).errors![0].code,"child_missing");
    await upload(missingResult.results![0].actions);assert((await reserve("deep",[needsMissing])).results);
    const oldOnly=leaf("old-only"),oldAllocation=(await reserve("leaves",[oldOnly])).results![0].actions;
    await s3.send(new PutObjectCommand({Bucket:b,Key:new URL(oldAllocation.read.url).pathname.slice(b.length+2),Body:bytes("x")}));
    assert((await reserve("deep",[parent(1,"needs-old",[oldOnly])])).results,"uncached old-generation target is verified");
    const wrong=leaf("wrong-length"),wrongAllocation=(await reserve("leaves",[wrong])).results![0].actions;
    const wrongKey=new URL(wrongAllocation.preview!.url).pathname.slice(b.length+2);
    await s3.send(new PutObjectCommand({Bucket:b,Key:wrongKey,Body:bytes("xx")}));
    assert.equal((await reserve("deep",[parent(1,"bad-content-length",[wrong])])).errors![0].code,"child_length_mismatch");
    const guarded=leaf("guarded"),guardedAllocation=(await reserve("leaves",[guarded])).results![0].actions;await upload(guardedAllocation);target=new URL(guardedAllocation.preview!.url).pathname;
    for(const failure of ["denied","unavailable"]){mode=failure;assert.equal((await reserve("deep",[parent(1,"guarded-parent",[guarded])])).errors![0].code,"child_unavailable");}
    mode="normal";hold=true;
    const waiting=reserve("deep",[parent(1,"guarded-parent",[guarded])]);await timeout(entered.promise);
    await timeout(status(await commit(app.url,"unrelated-head",bytes("root"),0n),201),3000);
    slow.resolve();assert((await waiting).results);hold=false;
    const graph=await inspect(await image(),rootId);assert.equal(graph.children.length,2);
    await stop(app.process);
    const limited=await server(await bucket(),endpoint,{BASINSYNC_NODE_MAX_DEGREE:"1"});
    const degree=await reserveHeap(limited.url,"f",0n,[left]);await status(degree.clone(),200);assert.equal(parse<HeapResponse>(await degree.text()).errors![0].code,"degree_limit");await stop(limited.process);
    const cleaner=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10",BASINSYNC_SWEEP_EDGE_BATCH_SIZE:"1",BASINSYNC_ERASE_BATCH_SIZE:"1",BASINSYNC_ERASE_CONCURRENCY:"1"});
    for(const flow of flows)await status(await commit(cleaner.url,flow,bytes("marker"),0n),201);
    await eventually(async()=>{const rows=await inspect(await image());return rows;},rows=>rows.userspace_nodes===0&&rows.userspace_edges===0&&rows.sweeping_tasks===0&&rows.marking_tasks===0);
    assert(checkedDeletion,"parent object deletion follows durable outbound edge removal");
    assert.equal((await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:`${objectKeys.userHeap}young/`}))).KeyCount,0);
    await stop(cleaner.process);
    const restored=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"}),tip=(await fullStatus(restored.url,"deep")).timelines.basin.milestone;
    const cp=await eventually(()=>basinBackup(b),cp=>!!cp&&cp.milestone>=tip);assert(cp);assert.deepEqual(await inspect(cp.blob),{userspace_nodes:0,userspace_edges:0,sweeping_tasks:0,marking_tasks:0});await stop(restored.process);
    for await(const page of paginateListObjectsV2({client:s3},{Bucket:b}))for(const object of page.Contents??[]){const r=await s3.send(new GetObjectCommand({Bucket:b,Key:object.Key!}));const body=Buffer.from(await r.Body!.transformToByteArray());assert(!body.includes(bytes("deep-node-auth-private-")),"child access tokens never reach storage");}
  });
  await scenario("0zg5 deep heap", "deep node DAGs, cached conditional HEADs in both generations, immutable child sets, degree/height limits, nonblocking verification, revision races, bounded recursive reclamation, and snapshot replay (2/2)", async () => {
    const b=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let held=false,target="";
    const proxy=relay(async(request,response)=>{if(!held&&request.method==="HEAD"&&new URL(request.url).pathname===target&&response.status===200){held=true;entered.resolve();await gate.promise;}return response;});
    const app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"15"});
    const child:HeapNode={auth:[0,0,bytes("verification-race-child")],length:1,edges:[]},parent:HeapNode={auth:[1,0,bytes("verification-race-parent")],length:1,edges:[{auth:child.auth}]};
    const reserve=async(flow:string,nodes:HeapNode[])=>{const r=await reserveHeap(app.url,flow,0n,nodes);await status(r.clone(),200);return parse<HeapResponse>(await r.text());};
    const first=(await reserve("old",[child])).results![0].actions;assert(first.write);const put=await fetch(first.write.url,{method:"PUT",headers:first.write.headers,body:bytes("x")});assert(put.ok);target=new URL(first.preview!.url).pathname;
    const pending=reserve("parent",[parent]);await timeout(entered.promise);
    await status(await commit(app.url,"old",bytes("marker"),0n),201);
    await eventually(async()=>{const r=await fetch(first.preview!.url,{headers:first.preview!.headers});await r.arrayBuffer();return r.status;},s=>s===404||s===412);
    const replacement=await eventually(()=>reserve("replacement",[child]),r=>!!r.results);const next=replacement.results![0].actions;assert(next.write);assert.notEqual(new URL(next.write.url).pathname,target);
    const write=await fetch(next.write.url,{method:"PUT",headers:next.write.headers,body:bytes("x")});assert(write.ok);gate.resolve();
    const rejected=await pending;assert.equal(rejected.errors![0].code,"child_changed");assert.equal(rejected.results,null);
    assert((await reserve("parent",[parent])).results);await stop(app.process);
  });

  await scenario("0zg6 marker edges", "authenticated marker edges, postorder marking, retained DAGs, bounded promotion, conditional COPY, foreground progress, and retry/restart/snapshot recovery (1/3)", async () => {
    const b=await bucket();let holdCopies=false,rootPath="",rootYoung="",copyCount=0,deleteFailed=false,ambiguous=true;
    const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
    async function image(){
      let bytes:Uint8Array|undefined;
      for(const m of (await committedKeys(s3,b,objectKeys.timeline)).map(fromKey).sort((a,b)=>a<b?-1:1)){
        const d=deltasAt(await get(b,m)).turso["default.turso"] as WalDelta;
        bytes=ingestWal(bytes??d.logical.base!,d.physical.segments);
      }
      assert(bytes);return bytes;
    }
    async function inspect(id:string,owner="unused",blob?:Uint8Array){
      const path=`${artifacts}/promotion-${serial++}.turso`;writeFileSync(path,blob??await image());
      const p=spawn([`${root}/target/debug/examples/frame-fixture`,"--heap",path,id,owner],{cwd:root,stdout:"pipe",stderr:"inherit"});
      const row=await new Response(p.stdout).json();assert.equal(await p.exited,0);return row;
    }
    const copies:string[]=[];
    const proxy=relay((request,response)=>{
      if(ambiguous&&request.headers.has("x-amz-copy-source")&&response.ok){ambiguous=false;return new Response("lost COPY reply",{status:500});}
      return response;
    },async request=>{
      const path=new URL(request.url).pathname;
      if(request.method==="PUT"&&path.includes(`/${objectKeys.userHeap}old/`)&&request.headers.has("x-amz-copy-source")){
        assert.equal(request.headers.get("if-none-match"),"*");assert(request.headers.get("x-amz-copy-source-if-match"));
        if(holdCopies&&path===rootPath){entered.resolve();await gate.promise;}
        copies.push(path);if(path===rootPath)copyCount++;
      }
      if(request.method==="DELETE"&&path===rootYoung&&!deleteFailed){deleteFailed=true;return new Response("retry",{status:500});}
    });
    let app=await server(b,proxy.url,{BASINSYNC_NODE_MAX_DEGREE:"1"});
    const auth=(h:number,s:string):HeapNode["auth"]=>[h,0,bytes(`marker-edge-private-${s}`)];
    const leaf:HeapNode={auth:auth(0,"leaf"),length:1,edges:[],context:{kind:"leaf",tag:"0x-context"}};
    const orphan:HeapNode={auth:auth(0,"orphan"),length:1,edges:[]};
    const reserve=async(flow:string,nodes:HeapNode[],vp=0n)=>{const r=await reserveHeap(app.url,flow,vp,nodes);await status(r.clone(),200);return parse<HeapResponse>(await r.text());};
    const upload=async(action:NonNullable<HeapResponse["results"]>[number]["actions"]["write"],body=bytes("x"))=>{assert(action);const r=await fetch(action.url,{method:"PUT",headers:action.headers,body});assert(r.ok,await r.text());};
    const leaves=await reserve("graph",[leaf,orphan]);await upload(leaves.results![0].actions.write);await upload(leaves.results![1].actions.write);
    const parent:HeapNode={auth:auth(1,"parent"),length:1,edges:[{auth:leaf.auth}],context:{kind:"parent"}};
    const parentActions=(await reserve("graph",[parent])).results![0].actions;assert(parentActions.preview);
    const parentId=new URL(parentActions.preview.url).pathname.split(`/${objectKeys.userHeap}young/`)[1]!.split("/").slice(0,-1).join("/");
    const missing=await commit(app.url,"graph",bytes("marker"),0n,undefined,[{auth:parent.auth}]);await status(missing.clone(),422);assert.equal(parse<ApiError>(await missing.text()).error,"child_missing");
    assert.deepEqual(await epilogueStatus(app.url,"graph"),{latest:null});
    const unknown=await commit(app.url,"graph",bytes("marker"),0n,undefined,[{auth:auth(0,"unknown")}]);await status(unknown.clone(),422);assert.equal(parse<ApiError>(await unknown.text()).error,"child_unknown");
    await status(await commit(app.url,"graph",bytes("marker"),0n,undefined,[{auth:parent.auth},{auth:leaf.auth}]),422);
    await status(await commit(app.url,"graph",bytes("marker"),0n,undefined,[{auth:[129,0,bytes("too-high")]}]),422);
    await status(await commit(app.url,"graph",bytes("marker"),0n,undefined,[{auth:[0,1,bytes("wrong-version")]}]),422);
    await upload(parentActions.write);
    rootPath=new URL(parentActions.read.url).pathname;rootYoung=new URL(parentActions.preview.url).pathname;
    await status(await commit(app.url,"graph",bytes("marker"),0n,undefined,[{auth:parent.auth},{auth:parent.auth}]),201);
    const markerImage=await image();const owner=`_m_graph/v.${lex(0n)}/e.${lex(0n)}`;
    assert((await inspect(parentId,owner,markerImage)).retained);
    const markerEvent=await get(b,(await committedKeys(s3,b,objectKeys.timeline)).map(fromKey).reduce((a,b)=>a>b?a:b));
    assert.equal((eventTuples(markerEvent)[0]![3] as {markers:Record<string,{edges:string[]}>}).markers.graph!.edges.length,1,"marker edge IDs are deduplicated");
    assert(!Buffer.from(markerEvent).includes(bytes("marker-edge-private-")),"marker auth tokens never persist");
    await mismatch(await commit(app.url,"graph",bytes("wrong"),0n,undefined,[{auth:parent.auth}]),1n);
    await stop(app.process);
    holdCopies=true;
    app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10",BASINSYNC_MARK_BATCH_SIZE:"1",BASINSYNC_SWEEP_EDGE_BATCH_SIZE:"1",BASINSYNC_ERASE_BATCH_SIZE:"1",BASINSYNC_ERASE_CONCURRENCY:"1"});
    await timeout(entered.promise);
    const parentMarked=await inspect(parentId,owner);assert(parentMarked.marked);assert.equal(parentMarked.promoted,"");assert.equal(parentMarked.freed,"");
    assert(!(await committedKeys(s3,b,`${objectKeys.userFlows}graph/`)).some(k=>k.endsWith(`/epilogue/${lex(0n)}`)),"no sign before the entire graph is promoted");
    await timeout(status(await commit(app.url,"foreground",bytes("responsive"),0n),201),3000);
    await s3.send(new CopyObjectCommand({Bucket:b,Key:rootPath.slice(b.length+2),CopySource:rootYoung.slice(1),CopySourceIfMatch:parentMarked.etag,IfNoneMatch:"*"}));
    gate.resolve();holdCopies=false;
    await eventually(()=>inspect(parentId,owner),r=>!!r.promoted);
    await eventually(async()=>exists(b,await signKey(b,"graph",0n)),Boolean);
    assert(deleteFailed&&!ambiguous);assert.equal(copyCount,1,"retry after DELETE failure HEADs the old copy instead of copying again");
    for(const actions of [leaves.results![0].actions,parentActions]){
      const r=await fetch(actions.read.url,{headers:actions.read.headers});assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes("x"));
      const expected=actions===parentActions?{kind:"parent"}:{kind:"leaf",tag:"0x-context"};
      for(const [key,value] of Object.entries(expected))assert.equal(r.headers.get(`x-amz-meta-ctx-${key}`),value);
      const y=await fetch(actions.preview!.url,{headers:actions.preview!.headers});assert([404,412].includes(y.status));await y.arrayBuffer();
    }
    await eventually(async()=>{const r=await fetch(leaves.results![1].actions.preview!.url,{headers:leaves.results![1].actions.preview!.headers});await r.arrayBuffer();return r.status;},s=>s===404||s===412);
    const repeated=(await reserve("graph",[parent],1n)).results![0].actions;assert.equal(repeated.write,null);assert.equal(repeated.preview,null);assert.equal(new URL(repeated.read.url).pathname,rootPath);
    const newParent:HeapNode={auth:auth(2,"new-parent"),length:1,edges:[{auth:parent.auth}]};
    assert((await reserve("next",[newParent])).results);
    await status(await commit(app.url,"other",bytes("old-node-edge"),0n,undefined,[{auth:parent.auth}]),201);
    const node=(await inspect(parentId,owner));assert(node.promoted&&node.marked&&!node.freed);
    await stop(app.process);
    app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10",BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const tip=(await fullStatus(app.url,"graph")).timelines.basin.milestone;
    const cp=await eventually(()=>basinBackup(b),v=>!!v&&v.milestone>=tip);assert(cp);
    const restored=await inspect(parentId,owner,cp.blob);assert(restored.retained&&restored.marked&&restored.promoted);
    await stop(app.process);
    assert(copies.length>=2,"both parent and child promoted");
  });
  await scenario("0zg6 marker edges", "authenticated marker edges, postorder marking, retained DAGs, bounded promotion, conditional COPY, foreground progress, and retry/restart/snapshot recovery (2/3)", async () => {
    // Retry an ambiguous successful COPY after restart; old presence protects the young source.
    const b=await bucket();let blocked=true,unsupported=true,ambiguous=true,copyAttempts=0,sourceReads=0;const copyRejected=Promise.withResolvers<void>();
    const proxy=relay(async(request,response)=>{
      if(ambiguous&&!unsupported&&request.headers.has("x-amz-copy-source")&&response.ok){ambiguous=false;await response.arrayBuffer();return new Response("lost COPY reply",{status:500});}
      return response;
    },async request=>{
      const path=new URL(request.url).pathname;
      if(request.method==="PUT"&&path.includes(`/${objectKeys.userHeap}old/`)&&request.headers.has("x-amz-copy-source")){
        copyAttempts++;if(unsupported){copyRejected.resolve();return new Response("unsupported",{status:501});}
      }
      if(request.method==="GET"&&path.includes(`/${objectKeys.userHeap}young/`))sourceReads++;
      if(request.method==="DELETE"&&path.includes(`/${objectKeys.userHeap}young/`)&&blocked)return new Response("deferred",{status:500});
    });
    let app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10"});
    const data=new Uint8Array(9*1024*1024+3);data.fill(42);data[0]=7;data[data.length-1]=19;
    const input:HeapNode={auth:[0,0,bytes("promotion-copy-private")],length:data.length,edges:[],context:{kind:"copy",tag:"0#species"}};
    const r=await reserveHeap(app.url,"f",0n,[input]);await status(r.clone(),200);const actions=parse<HeapResponse>(await r.text()).results![0].actions;assert(actions.write&&actions.preview);
    const p=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:data});assert(p.ok);
    await status(await commit(app.url,"f",bytes("marker"),0n,undefined,[{auth:input.auth}]),201);
    await timeout(copyRejected.promise);await Bun.sleep(40);assert.equal(sourceReads,0,"COPY failure cannot silently relay bytes");
    await stop(app.process);
    unsupported=false;
    app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10"});
    await eventually(async()=>{const r=await fetch(actions.read.url,{headers:actions.read.headers});await r.arrayBuffer();return r.status;},s=>s===200);
    assert.equal(sourceReads,0,"promotion never relays payload bytes");assert(!ambiguous,"HEAD resolves a lost COPY reply");
    const preview=await fetch(actions.preview.url,{headers:actions.preview.headers});assert.equal(preview.status,200);await preview.arrayBuffer();
    await stop(app.process);const before=copyAttempts;blocked=false;
    app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10"});
    await eventually(async()=>{const r=await reserveHeap(app.url,"f",1n,[input]);await status(r.clone(),200);return parse<HeapResponse>(await r.text());},r=>r.results?.[0]?.actions.preview===null);
    assert.equal(copyAttempts,before,"restart resumes deletion from verified old object");
    const old=await fetch(actions.read.url,{headers:actions.read.headers});assert.equal(old.status,200);assert.deepEqual(new Uint8Array(await old.arrayBuffer()),data);
    assert.equal(old.headers.get("x-amz-meta-ctx-kind"),"copy");assert.equal(old.headers.get("x-amz-meta-ctx-tag"),"0#species");
    await stop(app.process);
  });
  await scenario("0zg6 marker edges", "authenticated marker edges, postorder marking, retained DAGs, bounded promotion, conditional COPY, foreground progress, and retry/restart/snapshot recovery (3/3)", async () => {
    // A successful HEAD for a reclaimed revision cannot authorize a marker edge to its replacement.
    const b=await bucket(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let held=false,target="";
    const proxy=relay(async(request,response)=>{if(!held&&request.method==="HEAD"&&new URL(request.url).pathname===target&&response.status===200){held=true;entered.resolve();await gate.promise;}return response;});
    const app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"15"});
    const node:HeapNode={auth:[0,0,bytes("marker-verification-reuse-private")],length:1,edges:[]};
    const reserve=async(flow:string)=>{const r=await reserveHeap(app.url,flow,0n,[node]);await status(r.clone(),200);return parse<HeapResponse>(await r.text());};
    const first=(await reserve("stage")).results![0].actions;assert(first.write&&first.preview);
    let r=await fetch(first.write.url,{method:"PUT",headers:first.write.headers,body:bytes("x")});assert(r.ok);target=new URL(first.preview.url).pathname;
    const pending=commit(app.url,"marker",bytes("marker"),0n,undefined,[{auth:node.auth}]);await timeout(entered.promise);
    await status(await commit(app.url,"stage",bytes("release"),0n),201);
    await eventually(async()=>{const r=await fetch(first.preview!.url,{headers:first.preview!.headers});await r.arrayBuffer();return r.status;},s=>s===404||s===412);
    const next=(await eventually(()=>reserve("replacement"),r=>!!r.results)).results![0].actions;assert(next.write);assert.notEqual(new URL(next.write.url).pathname,target);
    r=await fetch(next.write.url,{method:"PUT",headers:next.write.headers,body:bytes("x")});assert(r.ok);gate.resolve();
    const rejected=await pending;await status(rejected.clone(),422);assert.equal(parse<ApiError>(await rejected.text()).error,"child_changed");
    assert.deepEqual(await epilogueStatus(app.url,"marker"),{latest:null});
    await status(await commit(app.url,"marker",bytes("retry"),0n,undefined,[{auth:node.auth}]),201);
    await stop(app.process);
  });

  await scenario("0zg6 marker edges", "uncomplemented PromotionSigns, empty graphs, retained tasks until S3 confirmation, ambiguous sign PUTs, restart repair, and mixed-key Epilogue recovery", async () => {
    const b=await bucket(),flow="sign-0x",attempted=Promise.withResolvers<void>();let target="";
    let stored=false,confirm=false,puts=0,rewrites=0;let mismatch=Promise.withResolvers<void>();
    async function counts(image?:Uint8Array){
      if(!image){
      for(const m of (await committedKeys(s3,b,objectKeys.timeline)).map(fromKey).sort((a,b)=>a<b?-1:1)){const d=deltasAt(await get(b,m)).turso["default.turso"] as WalDelta;image=ingestWal(image??d.logical.base!,d.physical.segments);}
      }
      assert(image);const path=`${artifacts}/signs-${serial++}.turso`;writeFileSync(path,image);
      const p=spawn([`${root}/target/debug/examples/frame-fixture`,"--graph",path],{cwd:root,stdout:"pipe",stderr:"inherit"});
      const rows=await new Response(p.stdout).json();assert.equal(await p.exited,0);return rows;
    }
    const proxy=relay((request,response)=>{
      if(request.method==="HEAD"&&new URL(request.url).pathname===`/${b}/${target}`&&response.status===200&&response.headers.get("x-amz-meta-upstream")!=="1")mismatch.resolve();
      if(request.method==="PUT"&&new URL(request.url).pathname===`/${b}/${target}`&&response.ok){rewrites++;stored=true;attempted.resolve();return new Response("lost sign reply",{status:500});}
      return response;
    },async request=>{
      if(new URL(request.url).pathname!==`/${b}/${target}`)return;
      if(request.method==="PUT"){puts++;assert.equal(request.headers.get("if-none-match"),"*");}
      if(request.method==="HEAD"){
        assert.equal(request.headers.get("if-match"),"*");assert.equal(request.headers.get("if-none-match"),null);
        if(stored&&!confirm)return new Response(null,{status:500});
      }
    });
    // Positive signs alone cannot be mistaken for a recovery marker.
    await s3.send(new PutObjectCommand({Bucket:b,Key:`${objectKeys.basinEpilogue}${lex(100n)}`,Body:new Uint8Array()}));
    let app=await server(b,proxy.url);
    await status(await commit(app.url,flow,new Uint8Array(),0n),201);
    await status(await commit(app.url,flow,bytes("second"),1n),201);
    target=await signKey(b,flow,0n);
    assert.equal((await counts()).marking_tasks,2,"empty graphs also queue marking tasks");
    await stop(app.process);
    app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10"});
    await timeout(attempted.promise);
    assert(await exists(b,target));assert((await counts()).marking_tasks>=1,"unconfirmed sign keeps its task");
    await status(await commit(app.url,"foreground-sign",bytes("responsive"),0n),201);
    await stop(app.process);const before=rewrites;confirm=true;
    for(const metadata of [{},{upstream:"999"}] as Record<string,string>[]){
      mismatch=Promise.withResolvers<void>();
      await s3.send(new PutObjectCommand({Bucket:b,Key:target,Body:wrapEnvelope(new Uint8Array([1]),6),Metadata:metadata}));
      app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10"});await timeout(mismatch.promise);
      assert((await counts()).marking_tasks>=1,"sign upstream must match its source Milestone");await stop(app.process);
    }
    await s3.send(new PutObjectCommand({Bucket:b,Key:target,Body:wrapEnvelope(new Uint8Array([1]),6),Metadata:{upstream:"1"}}));
    app=await server(b,proxy.url,{BASINSYNC_CLEANUP_INTERVAL_MS:"10",BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    await eventually(counts,r=>r.marking_tasks===0&&r.sweeping_tasks===0);
    // A conditional create that finds the sign (412) is not a rewrite.
    assert.equal(rewrites,before,"restart confirms an existing sign without rewriting it");
    assert.equal((await s3.send(new HeadObjectCommand({Bucket:b,Key:target}))).Metadata!.upstream,"1");
    assert.equal((await s3.send(new HeadObjectCommand({Bucket:b,Key:await signKey(b,flow,1n)}))).Metadata!.upstream,"2");
    assert(await exists(b,await signKey(b,"foreground-sign",0n)));
    const cp=await eventually(async()=>{const cp=await basinBackup(b);if(!cp)return null;const rows=await counts(cp.blob);return rows.marking_tasks===0&&rows.sweeping_tasks===0?cp:null;},Boolean);assert(cp);
    const cpViewpoint=~unlex(cp.key.slice(objectKeys.basinEpilogue.length));const cpSign=`${objectKeys.basinEpilogue}${lex(cpViewpoint)}`;
    await eventually(()=>exists(b,cpSign),Boolean);
    await eventually(()=>flowBlob(b,flow,1n),v=>!!v);await stop(app.process);
    const objects=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:await flowPrefix(b,flow)}));
    assert.deepEqual(objects.Contents!.map(o=>o.Key),[await flowKey(b,flow,0n),await flowKey(b,flow,1n),await signKey(b,flow,0n),await signKey(b,flow,1n)].sort());
    app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    await Bun.sleep(50);assert.equal((await basinBackup(b))!.key,cp.key,"idle restart does not back up its own bookkeeping");
    assert.deepEqual(await epilogueStatus(app.url,flow),{latest:{viewpoint:1n}});await stop(app.process);
  });

  await scenario("0zg3 shallow heap", "JSON0 context validation, Timeline metadata retention, ambiguous replication, revision-scoped keys, and snapshot-only Flow recovery", async () => {
    const b=await bucket(),flow="context-0-flow",body=bytes("context marker");
    let app=await server(b);
    const context={Kind:"0x-literal",owner:"alice",empty:"", "0-key":"0"};
    for(const invalid of [{"bad name":"x"},{a:"x\r\ny"},{A:"one",a:"two"},{big:"x".repeat(2048)}] as Record<string,string>[]){
      const rejected=await commit(app.url,flow,body,0n,undefined,[],invalid);await status(rejected.clone(),422);
      assert.equal(parse<ApiError>(await rejected.text()).error,"invalid_context");
      assert.equal((await fullStatus(app.url,flow)).latest,null);
    }
    await status(await commit(app.url,flow,body,0n,undefined,[],context),201);
    const initial=(await flowRevisions(b))[flow]!;
    const first=markerAt(await get(b,1n),flow);assert.deepEqual(first.context,context);
    await stop(app.process);
    app=await server(b);
    await status(await commit(app.url,flow,bytes("second"),1n,undefined,[],{owner:"bob"}),201);
    assert.equal((await flowRevisions(b))[flow],initial,"replay preserves the Flow allocation UUID");
    await stop(app.process);
    let lost=false;
    const proxy=relay(async(request,response)=>{
      if(!lost&&request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.userFlows}`)&&response.ok){lost=true;await response.arrayBuffer();return new Response("lost marker reply",{status:503});}
      return response;
    });
    app=await server(b,proxy.url,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const cp=await eventually(()=>basinBackup(b),cp=>cp?.milestone===2n);assert(cp);assert(lost);
    const firstKey=await flowKey(b,flow,0n),secondKey=await flowKey(b,flow,1n);
    assert(firstKey.includes(`/${initial}/epilogue/`));
    const stored=await s3.send(new GetObjectCommand({Bucket:b,Key:firstKey}));
    assert.deepEqual(envelopeMessage(await stored.Body!.transformToByteArray()),body);
    assert.deepEqual(stored.Metadata,{sha384:sha384(body),"ctx-kind":"0x-literal","ctx-owner":"alice","ctx-empty":"","ctx-0-key":"0"});
    const latest=await fullStatus(app.url,flow);assert(new URL(latest.latest!.url!).pathname.endsWith(`/${secondKey}`));
    assert.equal((await s3.send(new HeadObjectCommand({Bucket:b,Key:secondKey}))).Metadata!["ctx-owner"],"bob");
    await stop(app.process);
    // Recover from only the backup; the next commit keeps its existing namespace.
    for(const object of (await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.timeline}))).Contents??[])if(fromKey(object.Key!)<=cp.milestone)await s3.send(new DeleteObjectCommand({Bucket:b,Key:object.Key!}));
    app=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    assert.deepEqual(await latestBlob((await fullStatus(app.url,flow)).latest!),bytes("second"));
    const third=await commit(app.url,flow,bytes("third"),2n,undefined,[],{owner:"carol"});await status(third.clone(),201);
    const thirdMilestone=parse<CommitResponse>(await third.text()).timelines.basin.milestone;
    await eventually(()=>basinBackup(b),cp=>!!cp&&cp.milestone>=thirdMilestone);
    const thirdKey=`${objectKeys.userFlows}${flow}/${initial}/epilogue/${lex(~2n)}`;
    assert.equal((await s3.send(new HeadObjectCommand({Bucket:b,Key:thirdKey}))).Metadata!["ctx-owner"],"carol");
    await stop(app.process);
  });

  await scenario("0zg3 shallow heap", "per-node context validation, JSON0 header strings, signed metadata tamper rejection, and immutable reservation context before upload, after replay, and after snapshot recovery", async () => {
    const b=await bucket(),app=await server(b),flow="reservation-context";
    const node:HeapNode={auth:[0,0,bytes("context-node-private-token")],length:1,edges:[],context:{Kind:"0x-literal",owner:"alice",empty:""}};
    const input=[node,{...node,context:{owner:"bob"}},{...node,context:{"bad name":"x"}},{...node,context:{kind:"0x-literal",owner:"alice",empty:""}}];
    const r=await reserveHeap(app.url,flow,0n,input);await status(r.clone(),200);const result=parse<HeapResponse>(await r.text());
    assert.deepEqual(Object.keys(result.results!),["0","3"]);assert.equal(result.errors![1].code,"context_collision");assert.equal(result.errors![2].code,"invalid_context");
    const actions=result.results![0].actions,other=result.results![3].actions;assert(actions.write&&actions.preview&&other.write);
    assert.equal(actions.write.headers["x-amz-meta-ctx-kind"],"0x-literal","JSON0 must not decode header text as a bigint");
    const signed=new URL(actions.write.url).searchParams.get("X-Amz-SignedHeaders")!;
    for(const name of ["kind","owner","empty"])assert(signed.split(";").includes(`x-amz-meta-ctx-${name}`));
    const omitted={...actions.write.headers};delete omitted["x-amz-meta-ctx-owner"];
    for(const headers of [omitted,{...actions.write.headers,"x-amz-meta-ctx-owner":"mallory"}]){
      const bad:Response=await fetch(actions.write.url,{method:"PUT",headers,body:bytes("x")});assert(bad.status>=400);await bad.arrayBuffer();
    }
    for(const context of [{owner:"bob"},{}] as Record<string,string>[]){
      const mismatch=await reserveHeap(app.url,"other-flow",0n,[{...node,context}]);await status(mismatch.clone(),200);
      const rejected=parse<HeapResponse>(await mismatch.text());assert.equal(rejected.results,null);assert.equal(rejected.errors![0].code,"context_collision");
      assert.equal(rejected.timelines.basin.milestone,1n,"context mismatches do not mutate state");
    }
    const uploaded=await fetch(actions.write.url,{method:"PUT",headers:actions.write.headers,body:bytes("x")});assert(uploaded.ok,await uploaded.text());
    const collision=await fetch(other.write.url,{method:"PUT",headers:other.write.headers,body:bytes("x")});assert.equal(collision.status,412);await collision.arrayBuffer();
    const preview=await fetch(actions.preview.url,{headers:actions.preview.headers});assert.equal(preview.status,200);await preview.arrayBuffer();
    assert.equal(preview.headers.get("x-amz-meta-ctx-kind"),"0x-literal");assert.equal(preview.headers.get("x-amz-meta-ctx-owner"),"alice");
    await stop(app.process);
    const restored=await server(b);
    const again=await reserveHeap(restored.url,flow,0n,[{...node,context:{owner:"carol"}}]);await status(again.clone(),200);
    const rejected=parse<HeapResponse>(await again.text());assert.equal(rejected.results,null);assert.equal(rejected.errors![0].code,"context_collision");
    const retry=await reserveHeap(restored.url,flow,0n,[node]);await status(retry.clone(),200);
    const next=parse<HeapResponse>(await retry.text()).results![0].actions.write!;
    const duplicate=await fetch(next.url,{method:"PUT",headers:next.headers,body:bytes("x")});assert.equal(duplicate.status,412);await duplicate.arrayBuffer();
    const head=await s3.send(new HeadObjectCommand({Bucket:b,Key:new URL(next.url).pathname.slice(b.length+2)}));assert.equal(head.Metadata!["ctx-owner"],"alice");
    await status(await commit(restored.url,flow,bytes("marker"),0n),201);await stop(restored.process);
    const copying=await server(b,endpoint,{BASINSYNC_BACKUP_INTERVAL_MS:"10"});
    const cp=await eventually(()=>basinBackup(b),cp=>!!cp&&cp.milestone>=3n);assert(cp);await stop(copying.process);
    for(const object of (await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.timeline}))).Contents??[])if(fromKey(object.Key!)<=cp.milestone)await s3.send(new DeleteObjectCommand({Bucket:b,Key:object.Key!}));
    const snapshotOnly=await server(b);
    const mismatch=await reserveHeap(snapshotOnly.url,flow,1n,[{...node,context:{owner:"bob"}}]);await status(mismatch.clone(),200);
    const fromSnapshot=parse<HeapResponse>(await mismatch.text());assert.equal(fromSnapshot.results,null);assert.equal(fromSnapshot.errors![0].code,"context_collision");
    const matching=await reserveHeap(snapshotOnly.url,flow,1n,[node]);await status(matching.clone(),200);assert.equal(parse<HeapResponse>(await matching.text()).errors,null);
    await stop(snapshotOnly.process);
  });

  await scenario("0zg3 shallow heap", "competing Heap contexts have one durable agreement and reject the losing context after recovery", async () => {
    const b=await bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let puts=0;
    const proxy=relay((_,response)=>response,async request=>{
      if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){
        if(++puts===2)entered.resolve();await release.promise;
      }
    });
    const servers=await Promise.all([server(b,proxy.url),server(b,proxy.url)]);
    const inputs:HeapNode[]=["alice","bob"].map(owner=>({auth:[0,0,bytes("racing-context-token")],length:1,edges:[],context:{owner}}));
    const pending=Promise.all(servers.map((app,index)=>reserveHeap(app.url,`race-${index}`,0n,[inputs[index]!])));
    await timeout(entered.promise);release.resolve();const replies=await pending;
    assert.deepEqual(replies.map(r=>r.status).sort(),[200,503]);
    const winner=replies.findIndex(r=>r.status===200),loser=1-winner;
    await status(replies[winner]!.clone(),200);assert.equal(parse<HeapResponse>(await replies[winner]!.text()).errors,null);
    await status(replies[loser]!,503);await Promise.all(servers.map(app=>stop(app.process)));
    const restored=await server(b);
    const retry=await reserveHeap(restored.url,"retried-loser",0n,[inputs[loser]!]);await status(retry.clone(),200);
    const rejected=parse<HeapResponse>(await retry.text());assert.equal(rejected.results,null);assert.equal(rejected.errors![0].code,"context_collision");
    assert.equal(rejected.timelines.basin.milestone,1n);
    const matching=await reserveHeap(restored.url,"same-context",0n,[inputs[winner]!]);await status(matching.clone(),200);
    assert.equal(parse<HeapResponse>(await matching.text()).errors,null);await stop(restored.process);
  });

  const ok=report();
  console.log(`Integration ${ok?"passed":"failed"}. Logs: ${artifacts}`);
  if(!ok)process.exitCode=1;
} finally {
  await Promise.all(processes.map(stop));
  await Promise.all(relays.map(r=>r.stop(true)));
  s3.destroy();
}
