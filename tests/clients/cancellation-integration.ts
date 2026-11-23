import assert from "node:assert/strict";
import {createServer} from "node:net";
import {mkdtempSync,openSync,closeSync,readFileSync} from "node:fs";
import {S3Client,CreateBucketCommand,HeadObjectCommand,ListObjectsV2Command} from "@aws-sdk/client-s3";
import {commit,reserveHeap,parseResponse,form,epilogueStatus,type HeapResponse} from "./client";
import {s3Fixture} from "./s3-fixture";
import { objectKeys } from "./object-keys";

const root=new URL("../../",import.meta.url).pathname;
const artifacts=mkdtempSync(`${root}.local/cancellation-probe-`);
const processes:ReturnType<typeof Bun.spawn>[]=[];
const proxies:ReturnType<typeof Bun.serve>[]=[];
const credentials={accessKeyId:"audit-test",secretAccessKey:"audit-test-secret"};
const bytes=(s:string)=>new TextEncoder().encode(s);
async function port(){const s=createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
async function deadline<T>(p:Promise<T>,ms=15000){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([p,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(Error("deadline")),ms);})]);}finally{clearTimeout(timer!);}}
async function until<T>(get:()=>Promise<T>,ok:(t:T)=>boolean,ms=15000){const end=Date.now()+ms;while(Date.now()<end){try{const v=await get();if(ok(v))return v;}catch{}await Bun.sleep(20);}throw Error("until deadline");}
function launch(command:string[],env:Record<string,string>){const path=`${artifacts}/${processes.length}.log`,fd=openSync(path,"w");const process=Bun.spawn(command,{cwd:root,env:{...Bun.env,...env},stdout:fd,stderr:fd});closeSync(fd);processes.push(process);return {process,path};}
async function stop(p:ReturnType<typeof Bun.spawn>){if(p.exitCode!==null)return;p.kill("SIGINT");try{await deadline(p.exited,2000);}catch{p.kill("SIGKILL");await p.exited;}}
const endpoint=`http://127.0.0.1:${await port()}`;
const s3=new S3Client({endpoint,region:"us-east-1",forcePathStyle:true,credentials,maxAttempts:1});
let seq=0;
async function bucket(){const Bucket=`audit-${++seq}`;await s3.send(new CreateBucketCommand({Bucket}));return Bucket;}
async function app(Bucket:string,s3Endpoint:string,options:Record<string,string>={}){
  const address=`127.0.0.1:${await port()}`;
  const p=launch([`${root}target/debug/basinsync`],{BASINSYNC_LOG_FORMAT:"json",S3_ENDPOINT:s3Endpoint,S3_BUCKET:Bucket,AWS_REGION:"us-east-1",AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,AWS_SESSION_TOKEN:"",BASINSYNC_LISTEN:address,BASINSYNC_CLEANUP_INTERVAL_MS:"0",BASINSYNC_BULK_MAX_AGE_MS:"0",BASINSYNC_BACKUP_INTERVAL_MS:"0",BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",RUST_LOG:"basinsync=debug",...options});
  const url=`http://${address}`;await until(async()=>{if(p.process.exitCode!==null)throw Error(readFileSync(p.path,"utf8"));return (await fetch(`${url}/ready`)).status;},s=>s===404);return {...p,url};
}
function proxy(before:(request:Request)=>Promise<Response|void>,after:((request:Request,response:Response)=>Promise<void>)=async()=>{}){
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){const early=await before(request);if(early)return early;const url=new URL(request.url);const response=await fetch(`${endpoint}${url.pathname}${url.search}`,{method:request.method,headers:request.headers,body:["GET","HEAD"].includes(request.method)?undefined:await request.arrayBuffer(),redirect:"manual"});await after(request,response);return response;}});proxies.push(server);return `http://127.0.0.1:${server.port}`;
}
try{
  const fixture=s3Fixture(root,endpoint,`${artifacts}/s3`,credentials);
  launch(fixture.command,fixture.env);
  await until(async()=>{await s3.send(new CreateBucketCommand({Bucket:"readiness"}));return true;},Boolean);
  // Shutdown awaits an in-flight COPY; rejection preserves its source and a lost reply is verified.
  for(const fault of ["rejected","reply-lost"]){
    const b=await bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let copies=0,sourceReads=0;
    const p=proxy(async request=>{
      const u=new URL(request.url);
      if(request.method==="GET"&&u.pathname.includes(`/${objectKeys.userHeap}young/`))sourceReads++;
      if(request.method==="PUT"&&u.pathname.includes(`/${objectKeys.userHeap}old/`)&&request.headers.has("x-amz-copy-source")){
        copies++;assert.equal(request.headers.get("if-none-match"),"*");assert(request.headers.get("x-amz-copy-source-if-match"));entered.resolve();await release.promise;
        if(fault==="reply-lost"){
          const copied=await fetch(`${endpoint}${u.pathname}${u.search}`,{method:"PUT",headers:request.headers,body:await request.arrayBuffer()});assert(copied.ok);await copied.arrayBuffer();
          return new Response("lost COPY reply",{status:500});
        }
        return new Response("COPY unavailable",{status:501});
      }
    });
    const server=await app(b,p,{BASINSYNC_CLEANUP_INTERVAL_MS:"1000"});
    const data=new Uint8Array(9*1024*1024+3).fill(42),node={auth:[0,0,bytes("copy-audit-token")] as [number,number,Uint8Array],length:data.length,edges:[]};
    const reservation=await reserveHeap(server.url,"f",0n,[node]);assert.equal(reservation.status,200);const actions=(await parseResponse<HeapResponse>(reservation)).results![0].actions;
    const put=await fetch(actions.write!.url,{method:"PUT",headers:actions.write!.headers,body:data});assert(put.ok);
    assert.equal((await commit(server.url,"f",bytes("marker"),0n,undefined,[{auth:node.auth}])).status,201);
    await deadline(entered.promise);server.process.kill("SIGINT");await Bun.sleep(100);assert.equal(server.process.exitCode,null,"shutdown awaits the active COPY");
    release.resolve();assert.equal(await deadline(server.process.exited),0);assert.equal(copies,1);assert.equal(sourceReads,0);
    if(fault==="rejected"){
      await assert.rejects(s3.send(new HeadObjectCommand({Bucket:b,Key:decodeURIComponent(new URL(actions.read.url).pathname.slice(b.length+2))})));
      const source=await fetch(actions.preview!.url,{headers:actions.preview!.headers});assert.equal(source.status,200);assert.deepEqual(new Uint8Array(await source.arrayBuffer()),data);
    }
    const restored=await app(b,endpoint,{BASINSYNC_CLEANUP_INTERVAL_MS:"10"});
    await until(async()=>{const r=await fetch(actions.read.url,{headers:actions.read.headers});const body=new Uint8Array(await r.arrayBuffer());return r.status===200&&body.length===data.length;},Boolean);
    const old=await fetch(actions.read.url,{headers:actions.read.headers});assert.deepEqual(new Uint8Array(await old.arrayBuffer()),data);
    await stop(restored.process);
    console.log(`put of success: shutdown drains a ${fault} COPY without relaying bytes and restart completes promotion`);
  }
  // Disconnected requests still drain, including a prepared successor batch.
  for(const signal of (process.platform==="win32"?["SIGINT"]:["SIGINT","SIGTERM"]) as ("SIGINT"|"SIGTERM")[]){
    const b=await bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let puts=0;
    const p=proxy(async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){if(++puts===1){entered.resolve();await release.promise;}}});
    const server=await app(b,p),abort=new AbortController();
    const request=fetch(`${server.url}/api/v0/epilogue`,{method:"PUT",body:form("disconnect",bytes("marker"),0n),signal:abort.signal}).then(()=>"response",()=>"disconnected");
    await deadline(entered.promise);abort.abort();assert.equal(await request,"disconnected");
    const successor=commit(server.url,"disconnect",bytes("next marker"),1n);
    await until(async()=>readFileSync(server.path,"utf8"),s=>s.split("\n").some(line=>{try{const e=JSON.parse(line);return e.fields?.message==="batch prepared"&&(e.fields?.milestone??e.span?.milestone)==="2";}catch{return false;}}));
    server.process.kill(signal);await Bun.sleep(100);assert.equal(server.process.exitCode,null,"shutdown waits for admitted work");
    release.resolve();assert.equal((await successor).status,201);assert.equal(await deadline(server.process.exited),0);assert.equal(puts,2);
    const restored=await app(b,endpoint);assert.equal((await epilogueStatus(restored.url,"disconnect")).latest?.viewpoint,1n);await stop(restored.process);
    console.log(`put of success: ${signal} drains disconnected and pipelined commits in order and recovery sees both`);
  }
  // Starting/stopping an idle replica must not advance the Timeline or create backups.
  for(const option of [undefined,"false"]){
    const b=await bucket(),options:Record<string,string>={BASINSYNC_BACKUP_INTERVAL_MS:"3600000"};
    if(option!==undefined)options.BASINSYNC_BACKUP_ON_SHUTDOWN=option;
    let timelinePuts=0;
    const p=proxy(async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`))timelinePuts++;});
    const server=await app(b,p,options);
    assert.equal((await commit(server.url,"no-final-backup",bytes("marker"),0n)).status,201);
    const keys=async(prefix:string)=>(await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:prefix}))).Contents?.map(o=>o.Key)??[];
    const before=await keys(objectKeys.timeline);assert.equal(before.length,1);
    server.process.kill("SIGINT");assert.equal(await deadline(server.process.exited),0);
    assert.deepEqual(await keys(objectKeys.timeline),before);assert.deepEqual(await keys(objectKeys.basinEpilogue),[]);assert.deepEqual(await keys(objectKeys.kernelHeap),[]);assert.equal(timelinePuts,1);
    const replica=await app(b,p,options);assert.equal((await epilogueStatus(replica.url,"no-final-backup")).latest!.viewpoint,0n);
    replica.process.kill("SIGINT");assert.equal(await deadline(replica.process.exited),0);assert.deepEqual(await keys(objectKeys.timeline),before);assert.equal(timelinePuts,1);
  }
  console.log("put of success: default and explicit-false shutdowns leave Timeline/Epilogue state unchanged across replica restart");
  // An explicit opt-in wakes the worker for a final backup, even without a periodic schedule.
  for(const interval of ["3600000","0"]){
    const b=await bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let backups=0;
    const p=proxy(async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${b}/${objectKeys.basinEpilogue}`)&&request.headers.has("x-amz-meta-milestone")){backups++;entered.resolve();await release.promise;}});
    const server=await app(b,p,{BASINSYNC_BACKUP_INTERVAL_MS:interval,BASINSYNC_BACKUP_ON_SHUTDOWN:"true"});
    assert.equal((await commit(server.url,"backup",bytes("marker"),0n)).status,201);assert.equal(backups,0);
    server.process.kill("SIGINT");await deadline(entered.promise);await Bun.sleep(50);assert.equal(server.process.exitCode,null);
    release.resolve();assert.equal(await deadline(server.process.exited),0);assert.equal(backups,1);
  }
  console.log("put of success: opted-in shutdown awaits a final backup with a long or disabled periodic interval");
  // The drain deadline is explicit and exits unsuccessfully rather than claiming completion.
  {
    const b=await bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const p=proxy(async request=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)){entered.resolve();await release.promise;return new Response("not stored",{status:503});}});
    const server=await app(b,p,{BASINSYNC_SHUTDOWN_TIMEOUT_MS:"100"}),abort=new AbortController();
    const request=fetch(`${server.url}/api/v0/epilogue`,{method:"PUT",body:form("timeout",bytes("marker"),0n),signal:abort.signal}).catch(()=>null);
    await deadline(entered.promise);abort.abort();await request;server.process.kill("SIGINT");
    assert.equal(await deadline(server.process.exited),1);release.resolve();assert(readFileSync(server.path,"utf8").includes("shutdown drain timed out"));
    console.log("put of success: exhausted shutdown deadline reports failure with an uncertain in-flight outcome");
  }
  console.log(`Artifacts: ${artifacts}`);
}finally{
  await Promise.all(processes.map(stop));await Promise.all(proxies.map(p=>p.stop(true)));s3.destroy();
}
