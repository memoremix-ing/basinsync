import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { spawn } from "bun";
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, paginateListObjectsV2 } from "@aws-sdk/client-s3";
import { encode as flexEncode } from "flatbuffers/js/flexbuffers.js";
import { encode as extensionEncode } from "./flexbuffer";
import { commit, form, epilogueStatus, sha384, sha384Bytes, type ApiError, type Position, type ViewpointMismatch } from "./client";
import { parse, stringify } from "./json0";
import { key, fromKey } from "./diffuse16";
import { encodeEvent, markerAt, type Marker } from "./events";
import { stress } from "./stress";

const root = resolve(import.meta.dir, "..");
mkdirSync(`${root}/.local`, { recursive: true });
const artifacts = mkdtempSync(`${root}/.local/timeline-`);
const processes: ReturnType<typeof spawn>[] = [];
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
  const log = openSync(`${artifacts}/process-${serial++}.log`,"w");
  const p = spawn(command,{cwd:root,env:{...Bun.env,...env},stdout:log,stderr:log});
  closeSync(log); processes.push(p); return p;
}
async function stop(p: ReturnType<typeof spawn>) {
  if (p.exitCode !== null) return;
  p.kill("SIGINT");
  try { await timeout(p.exited,6000); } catch { p.kill("SIGKILL"); await p.exited; }
}
async function ready(p: ReturnType<typeof spawn>, probe: () => Promise<unknown>) {
  const until = Date.now()+15000;
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
function serverProcess(bucket: string, s3Endpoint: string, address: string) {
  return launch([`${root}/target/debug/basinsync`],{
    S3_ENDPOINT:s3Endpoint,S3_BUCKET:bucket,AWS_REGION:"us-east-1",
    AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,
    AWS_SESSION_TOKEN:"",BASINSYNC_LISTEN:address,
  });
}
async function server(bucket: string, s3Endpoint = endpoint) {
  const address = `127.0.0.1:${await freePort()}`;
  const p = serverProcess(bucket,s3Endpoint,address); const url = `http://${address}`;
  await ready(p,async () => {
    const r = await fetch(`${url}/ready`); assert.equal(r.status,404); await r.text();
  });
  return {process:p,url};
}
function relay(after: (request: Request, response: Response) => Promise<Response> | Response) {
  const service = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const url = new URL(request.url);
    const response = await fetch(`${endpoint}${url.pathname}${url.search}`,{
      method:request.method,headers:request.headers,
      body:request.method==="PUT" ? await request.arrayBuffer() : undefined,
      redirect:"manual",
    });
    return after(request,response);
  }});
  relays.push(service);
  return {service,url:`http://127.0.0.1:${service.port}`};
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
async function get(bucket: string, moment: bigint) {
  const r = await s3.send(new GetObjectCommand({Bucket:bucket,Key:key(moment)}));
  return r.Body!.transformToByteArray();
}
const marker = (blob: Uint8Array, viewpoint="0"): Marker => ({blob,viewpoint,sha384:sha384(blob)});
async function seed(bucket: string, moment: bigint, payload: Uint8Array) {
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:key(moment),Body:payload}));
}
async function badStartup(bucket: string) {
  assert.equal(await timeout(serverProcess(bucket,endpoint,"127.0.0.1:0").exited),1);
}

try {
  const fs = launch([process.env.FS_BIN ?? `${root}/.local/bin/fs`,"s3","--addr",new URL(endpoint).host,"--root",`${artifacts}/s3`],{
    FS_ROOT_ACCESS_KEY:credentials.accessKeyId,FS_ROOT_SECRET_KEY:credentials.secretAccessKey,
  });
  await ready(fs,async()=>{await s3.send(new CreateBucketCommand({Bucket:"readiness"}));});
  const b = await bucket();
  // Epilogue contents must never become a source of Basin state.
  await s3.send(new PutObjectCommand({Bucket:b,Key:"epilogue/0",Body:bytes("legacy, not a Timeline")}));
  const trace: {method:string;url:URL}[] = [];
  const traced = relay((r,response)=>{ trace.push({method:r.method,url:new URL(r.url)}); return response; });
  let writer = await server(b,traced.url);
  const observer = await server(b,traced.url);
  const flowA = "0x雪/first", flowB = "__proto__";
  const a = bytes("359");
  assert(sha384(a).startsWith("00"));
  assert.deepEqual(await epilogueStatus(writer.url,flowA),{latest:null,recent:null});
  await mismatch(await commit(writer.url,flowA,a,1n),0n);
  for (const kind of ["missing-metadata","duplicate-metadata","missing-flow","nul-flow","missing-blob","duplicate-blob","unknown-part","legacy-part","unknown-metadata","decimal","number","negative","missing-viewpoint","missing-digest","hex-digest","array-digest","wrong-digest","short-digest","long-digest","malformed-json","duplicate-property","unescaped-flow","invalid-base64"]) {
    const data = form(flowA,a,0n);
    const metadata: Record<string,unknown> = {flow:flowA,viewpoint:0n,sha384:sha384Bytes(a)};
    if(kind==="missing-flow")delete metadata.flow;
    if(kind==="nul-flow")metadata.flow="x\0y";
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
  assert.deepEqual(keys,Array.from({length:total},(_,i)=>key(BigInt(i+1))).sort());
  assert(fromKey(keys[0])<BigInt(total),"lowest key is a seed, not the latest Moment");
  const replayed = new Map<string,bigint>();
  let read=1;
  const events = new Map<number,{flow:string;marker:Marker}>();
  await Promise.all(Array.from({length:16},async()=>{
    while(read<=total){
      const m=read++;const payload=await get(b,BigInt(m));
      const matches:{flow:string;marker:Marker}[]=[];
      for(const flow of receipts.keys()) {try{matches.push({flow,marker:markerAt(payload,flow)})}catch{}}
      assert.equal(matches.length,1,`one marker in event ${m}`);
      const event=matches[0]; const v=BigInt(event.marker.viewpoint);
      assert.equal(event.marker.sha384,sha384(event.marker.blob));
      assert.deepEqual(event.marker.blob,receipts.get(event.flow)?.get(v));
      events.set(m,event);
    }
  }));
  for(let m=1;m<=total;m++){
    const {flow,marker}=events.get(m)!;const v=BigInt(marker.viewpoint);
    assert.equal(v,(replayed.get(flow)??-1n)+1n); replayed.set(flow,v);
  }
  const all=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"epilogue/"}));
  assert.deepEqual(all.Contents?.map(o=>o.Key),["epilogue/0"],"Flow copies are deferred");
  await stop(writer.process);
  const start=trace.length;
  writer=await server(b,traced.url);
  const startup=trace.slice(start);
  assert.equal(startup.filter(r=>r.method==="GET"&&r.url.searchParams.get("prefix")==="timeline/").length,1);
  assert.equal(startup.filter(r=>r.method==="GET"&&r.url.pathname.includes("/timeline/")).length,total,"replay the entire Timeline");
  for(const [flow,v] of replayed) assert.deepEqual(await epilogueStatus(writer.url,flow),{latest:{viewpoint:v},recent:null});
  assert(!trace.some(r=>r.url.searchParams.get("prefix")?.startsWith("epilogue/")),"never list Epilogue state");
  await accepted(writer.url,flowA,bytes("after recovery"),2n);
  await stop(writer.process);await stop(observer.process);
  console.log(`put of success: ${total} gapless Moments, Rust/TypeScript FlexBuffers interoperability, full replay, and minimum-key seed search`);

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

  // A JavaScript-produced multi-Flow command must replay in Rust, including a
  // Flow above 64-bit Viewpoint precision that is rejected as a gap.
  const fixture=await bucket();
  await seed(fixture,1n,encodeEvent({[flowA]:marker(a),[flowB]:marker(new Uint8Array())}));
  const restored=await server(fixture);
  assert.deepEqual(await epilogueStatus(restored.url,flowA),{latest:{viewpoint:0n},recent:null});
  assert.deepEqual(await epilogueStatus(restored.url,flowB),{latest:{viewpoint:0n},recent:null});
  await status(await commit(restored.url,flowA,a,1n<<128n),409);
  await status(await commit(restored.url,flowA,a,1n),201);
  await stop(restored.process);
  const invalid: (()=>Promise<string>)[] = [
    async()=>{const b=await bucket();await s3.send(new PutObjectCommand({Bucket:b,Key:"timeline/0",Body:a}));return b},
    async()=>{const b=await bucket();await seed(b,2n,encodeEvent({f:marker(a)}));return b},
    async()=>{const b=await bucket();await seed(b,1n,encodeEvent({f:{...marker(a),sha384:"00".repeat(48)}}));return b},
    async()=>{const b=await bucket();await seed(b,1n,encodeEvent({f:marker(a,"18446744073709551616")}));return b},
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
  console.log(`Integration passed. Logs: ${artifacts}`);
} finally {
  await Promise.all(processes.map(stop));
  await Promise.all(relays.map(r=>r.stop(true)));
  s3.destroy();
}
