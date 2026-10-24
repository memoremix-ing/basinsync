// Real HTTP/S3 comparison of background backup cost; all state caches live on disk.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { spawn } from "bun";
import { S3Client, CreateBucketCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { commit, epilogueStatus, sha384 } from "./client";
import { key as epilogueKey } from "./lexidecimal";

const root=resolve(import.meta.dir,"..");mkdirSync(`${root}/.local`,{recursive:true});
const artifacts=mkdtempSync(`${root}/.local/backup-benchmark-`);
const credentials={accessKeyId:"basinsync-test",secretAccessKey:"basinsync-test-secret"};
const children:ReturnType<typeof spawn>[]=[];let serial=0;
function launch(command:string[],env:Record<string,string>={}){
  const fd=openSync(`${artifacts}/${serial++}.log`,"w");
  const child=spawn(command,{cwd:root,env:{...Bun.env,...env},stdout:fd,stderr:fd});closeSync(fd);children.push(child);return child;
}
async function stop(child:ReturnType<typeof spawn>){if(child.exitCode===null){child.kill("SIGINT");await child.exited;}}
async function port(){const socket=createServer();await new Promise<void>(yes=>socket.listen(0,"127.0.0.1",yes));const a=socket.address();assert(a&&typeof a!=="string");await new Promise<void>(yes=>socket.close(()=>yes()));return a.port;}
async function until(test:()=>Promise<boolean>){const end=Date.now()+60000;while(Date.now()<end){if(await test())return;await Bun.sleep(10);}throw Error(`deadline: ${artifacts}`);}
const endpoint=`http://127.0.0.1:${await port()}`;
const s3=new S3Client({endpoint,region:"us-east-1",forcePathStyle:true,credentials,maxAttempts:1});
let delayMs=0,backupPuts=0;
const relay=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  const url=new URL(request.url),basinPut=request.method==="PUT"&&url.pathname.includes("/epilogue/")&&!url.pathname.includes("/flows/");
  if(basinPut){backupPuts++;if(delayMs)await Bun.sleep(delayMs);}
  return fetch(`${endpoint}${url.pathname}${url.search}`,{method:request.method,headers:request.headers,body:["GET","HEAD"].includes(request.method)?undefined:await request.arrayBuffer()});
}});
const configurations=[{name:"off",interval:0,delay:0},{name:"default",interval:1000,delay:0},{name:"backup",interval:20,delay:0},{name:"backup+100ms",interval:20,delay:100}].filter(c=>!process.env.BACKUP_MODES||process.env.BACKUP_MODES.split(",").includes(c.name));
assert(configurations.length>0);
const rounds=Number(process.env.BACKUP_ROUNDS??3),perFlow=Number(process.env.BACKUP_COMMITS_PER_FLOW??128),flows=4,seedFlows=1024;
const samples:{round:number;mode:string;requests:number;seconds:number;rps:number;p50:number;p95:number;backups:number}[]=[];
const quantile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))];
try{
  const fs=launch([process.env.FS_BIN??`${root}/.local/bin/fs`,"s3","--addr",new URL(endpoint).host,"--root",`${artifacts}/s3`],{FS_ROOT_ACCESS_KEY:credentials.accessKeyId,FS_ROOT_SECRET_KEY:credentials.secretAccessKey});
  await until(async()=>{assert.equal(fs.exitCode,null);try{await s3.send(new CreateBucketCommand({Bucket:"readiness"}));return true;}catch{return false;}});
  for(let round=0;round<rounds;round++)for(let i=0;i<configurations.length;i++){
    const config=configurations[(round+i)%configurations.length];delayMs=config.delay;backupPuts=0;
    const bucket=`backup-bench-${round}-${i}`;await s3.send(new CreateBucketCommand({Bucket:bucket}));
    const address=`127.0.0.1:${await port()}`,url=`http://${address}`;
    const app=launch([`${root}/target/release/basinsync`],{S3_ENDPOINT:`http://127.0.0.1:${relay.port}`,S3_BUCKET:bucket,AWS_REGION:"us-east-1",AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,AWS_SESSION_TOKEN:"",BASINSYNC_LISTEN:address,BASINSYNC_BACKUP_INTERVAL_MS:String(config.interval),BASINSYNC_DATA_DIR:`${artifacts}/state`,BASINSYNC_BATCH_MAX:"32",BASINSYNC_BATCH_WAIT_MS:"2"});
    await until(async()=>{assert.equal(app.exitCode,null);try{return (await fetch(`${url}/ready`)).status===404;}catch{return false;}});
    // A 16 KiB-page database with 1,024 initial Flow rows, outside measurement.
    const seed=await Promise.all(Array.from({length:32},async(_,lane)=>{
      for(let n=lane;n<seedFlows;n+=32){const r=await commit(url,`seed-${n.toString().padStart(5,"0")}-${"x".repeat(400)}`,new Uint8Array(),0n);assert.equal(r.status,201);await r.text();}
    }));void seed;
    const seeded=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:"timeline/"}));assert(!seeded.IsTruncated);const seedTail=BigInt(seeded.KeyCount!);
    await until(async()=>{if(!config.interval)return true;const list=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:"epilogue/",MaxKeys:1}));const k=list.Contents?.[0]?.Key;if(!k)return false;const r=await s3.send(new GetObjectCommand({Bucket:bucket,Key:k}));await r.Body!.transformToByteArray();return BigInt(r.Metadata!.milestone)===seedTail;});
    backupPuts=0;
    const latencies:number[]=[],start=performance.now();
    await Promise.all(Array.from({length:flows},async(_,flow)=>{
      const payload=new Uint8Array(1024).fill(flow);
      for(let n=0;n<perFlow;n++){const at=performance.now(),r=await commit(url,`live-${flow}`,payload,BigInt(n));assert.equal(r.status,201);await r.text();latencies.push(performance.now()-at);}
    }));
    const seconds=(performance.now()-start)/1000,putsDuringRequests=backupPuts;
    const events=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:"timeline/"}));assert(!events.IsTruncated,"raise listing bound for this workload");const tail=BigInt(events.KeyCount!);
    if(config.interval){
      await until(async()=>{const list=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:"epilogue/",MaxKeys:1}));const k=list.Contents?.[0]?.Key;if(!k)return false;const r=await s3.send(new GetObjectCommand({Bucket:bucket,Key:k}));const bytes=await r.Body!.transformToByteArray();assert.equal(r.Metadata!.sha384,sha384(bytes));return BigInt(r.Metadata!.milestone)===tail;});
      for(let flow=0;flow<flows;flow++){
        const state=await epilogueStatus(url,`live-${flow}`);assert.equal(state.latest?.viewpoint,BigInt(perFlow-1));assert.equal(state.recent?.viewpoint,BigInt(perFlow-1));
        const r=await s3.send(new GetObjectCommand({Bucket:bucket,Key:`flows/0x${Buffer.from(`live-${flow}`).toString("hex")}/${epilogueKey(BigInt(perFlow-1))}`}));assert.deepEqual(await r.Body!.transformToByteArray(),new Uint8Array(1024).fill(flow));
      }
    }
    samples.push({round,mode:config.name,requests:flows*perFlow,seconds,rps:flows*perFlow/seconds,p50:quantile(latencies,.5),p95:quantile(latencies,.95),backups:putsDuringRequests});
    console.log(JSON.stringify(samples.at(-1)));await stop(app);
  }
  const summary=configurations.map(c=>{const rows=samples.filter(s=>s.mode===c.name);return {mode:c.name,rps:quantile(rows.map(r=>r.rps),.5),p50:quantile(rows.map(r=>r.p50),.5),p95:quantile(rows.map(r=>r.p95),.5)};});
  writeFileSync(`${artifacts}/samples.json`,JSON.stringify({rounds,perFlow,flows,seedFlows,configurations,samples,summary},null,2));console.log(JSON.stringify({summary,artifacts}));
}finally{await Promise.all(children.map(stop));await relay.stop(true);s3.destroy();}
