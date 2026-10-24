import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { spawn, spawnSync } from "bun";

const root=resolve(import.meta.dir,"..");mkdirSync(`${root}/.local`,{recursive:true});
const artifacts=mkdtempSync(`${root}/.local/shadow-benchmark-`);
const rounds=Number(Bun.env.DISK_ROUNDS ?? 3);
const workloads=(Bun.env.DISK_WORKLOADS ?? "8192:0,8192:1024").split(",").map(s=>{const [flows,rowBytes]=s.split(":").map(Number);return {flows,rowBytes}});
const modes=(Bun.env.DISK_MODES ?? "file,s3").split(",");
const delays=(Bun.env.DISK_PUT_DELAYS_MS ?? "0").split(",").map(Number);
const configs=(Bun.env.DISK_CAPTURES ?? "none,shadow,redb").split(",").flatMap(capture=>(Bun.env.DISK_WINDOWS ?? "1,4").split(",").map(Number).flatMap(window=>delays.map(putDelayMs=>({capture,window,putDelayMs}))));
const cpuGroups=Number(Bun.env.DISK_CPU_GROUPS ?? 128),s3Requests=Number(Bun.env.DISK_S3_REQUESTS ?? 256);
const s3Groups=Bun.env.DISK_S3_GROUPS ? Number(Bun.env.DISK_S3_GROUPS) : undefined;
const s3WarmupGroups=Bun.env.DISK_S3_WARMUP_GROUPS ? Number(Bun.env.DISK_S3_WARMUP_GROUPS) : undefined;
assert(rounds>0 && cpuGroups>0 && s3Requests>0 && s3Requests%32===0);
assert(delays.every(n=>Number.isInteger(n) && n>=0));
assert(s3Groups===undefined || Number.isInteger(s3Groups) && s3Groups>0);
assert(s3WarmupGroups===undefined || Number.isInteger(s3WarmupGroups) && s3WarmupGroups>0);
type Sample={group:number;latency_us:number;admission_us:number;primary_us:number;shadow_us:number;shadow_queued_us:number;encode_us:number;put_us:number;event_bytes:number};
type Run={capture:string;mode:string;flows:number;rowBytes:number;batch:number;window:number;put_delay_ms:number;round:number;groups:number;warmup:number;initial_bytes:number;setup_us:number;setup_disk_bytes:number;final_files:Record<string,number>;primary_seconds:number;total_seconds:number;requests_per_second:number;admitted_peak:number;samples:Sample[]};
async function run(command:string[],env:Record<string,string>,log:string){const p=spawn(command,{cwd:root,env:{...Bun.env,...env},stdout:"pipe",stderr:"pipe"});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);writeFileSync(log,out+"\n"+err);assert.equal(code,0,`${log}\n${out.slice(-2200)}\n${err.slice(-2200)}`);return out;}
function system(command:string[],cwd=root){const r=spawnSync(command,{cwd});assert.equal(r.exitCode,0);return new TextDecoder().decode(r.stdout).trim();}
function quantile(values:number[],q:number){const sorted=values.toSorted((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*q)-1)];}
function stats(values:number[]){return {mean:values.reduce((a,b)=>a+b,0)/values.length,p50:quantile(values,.5),p95:quantile(values,.95),min:Math.min(...values),max:Math.max(...values)};}
console.log(`Disk shadow artifacts: ${artifacts}`);
const build=await run(["cargo","test","--locked","--profile","bench","--lib","--no-run","--message-format=json"],{},`${artifacts}/build.log`);
const binary=build.split("\n").filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.reason==="compiler-artifact" && row.target.kind.includes("lib") && row.executable)?.executable;assert(typeof binary==="string");
const socket=createServer();await new Promise<void>(yes=>socket.listen(0,"127.0.0.1",yes));const address=socket.address();assert(address && typeof address!=="string");const port=address.port;await new Promise<void>((yes,no)=>socket.close(e=>e?no(e):yes()));
const endpoint=`http://127.0.0.1:${port}`,credentials={accessKeyId:"shadow-local",secretAccessKey:"shadow-local-secret"};
const s3=new S3Client({endpoint,region:"us-east-1",forcePathStyle:true,credentials,maxAttempts:1});
const log=openSync(`${artifacts}/s3.log`,"w");const service=spawn([Bun.env.FS_BIN ?? `${root}/.local/bin/fs`,"s3","--addr",`127.0.0.1:${port}`,"--root",`${artifacts}/s3`],{cwd:root,env:{...Bun.env,FS_ROOT_ACCESS_KEY:credentials.accessKeyId,FS_ROOT_SECRET_KEY:credentials.secretAccessKey},stdout:log,stderr:log});closeSync(log);
const runs:Run[]=[];
try{
 const deadline=Date.now()+15000;for(;;){try{await s3.send(new CreateBucketCommand({Bucket:"disk-shadow-ready"}));break}catch(e){if(Date.now()>deadline)throw e;await Bun.sleep(30)}}
 for(const w of workloads)await run([binary,"--exact","turso::wal::zsets::shadow::seed_disk","--ignored","--nocapture"],{DISK_SEED:`${artifacts}/seed-${w.flows}-${w.rowBytes}.turso`,DISK_SEED_EVENT:`${artifacts}/seed-${w.flows}-${w.rowBytes}.event`,DISK_FLOWS:String(w.flows),DISK_ROW_BYTES:String(w.rowBytes)},`${artifacts}/seed-${w.flows}-${w.rowBytes}.log`);
 for(const mode of modes)for(let round=Number(Bun.env.DISK_ROUND_OFFSET ?? 0);round<rounds+Number(Bun.env.DISK_ROUND_OFFSET ?? 0);round++)for(const w of (round%2?workloads.toReversed():workloads))for(const batch of (round%2?(Bun.env.DISK_BATCHES ?? "1,32").split(",").map(Number).toReversed():(Bun.env.DISK_BATCHES ?? "1,32").split(",").map(Number)))for(let i=0;i<configs.length;i++){
  const {capture,window,putDelayMs}=configs[(i+round)%configs.length];const name=`${mode}-r${round}-${w.flows}-p${w.rowBytes}-b${batch}-${capture}-w${window}-d${putDelayMs}`;const bucket=`disk-${name}`;
  if(mode==="s3")await s3.send(new CreateBucketCommand({Bucket:bucket}));
  const warmup=mode==="file"?32:(s3WarmupGroups ?? 64/batch),groups=warmup+(mode==="file"?cpuGroups:(s3Groups ?? s3Requests/batch));
  await run([binary,"--exact","turso::wal::zsets::shadow::measure_disk","--ignored","--nocapture","--test-threads=1"],{DISK_CAPTURE:capture,DISK_MODE:mode,DISK_FLOWS:String(w.flows),DISK_BATCH:String(batch),DISK_GROUPS:String(groups),DISK_WARMUP:String(warmup),DISK_WINDOW:String(window),DISK_PUT_DELAY_MS:String(putDelayMs),DISK_SEED:`${artifacts}/seed-${w.flows}-${w.rowBytes}.turso`,DISK_SEED_EVENT:`${artifacts}/seed-${w.flows}-${w.rowBytes}.event`,DISK_OUTPUT:`${artifacts}/${name}.json`,S3_ENDPOINT:endpoint,S3_BUCKET:bucket,AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey},`${artifacts}/${name}.log`);
  const result=JSON.parse(readFileSync(`${artifacts}/${name}.json`,"utf8")) as Run;result.round=round;result.rowBytes=w.rowBytes;
  assert.equal(result.samples.length,groups-warmup);assert(result.admitted_peak<=window);
  assert.equal(result.put_delay_ms,putDelayMs);
  if(putDelayMs>0){assert(result.samples.every(s=>s.put_us>=putDelayMs*1000));assert(result.requests_per_second<=batch*1000/putDelayMs*1.01);}
  runs.push(result);writeFileSync(`${artifacts}/samples.json`,JSON.stringify(runs));
  console.log(`${name}: ${result.requests_per_second.toFixed(1)} req/s; ack p50 ${(quantile(result.samples.map(s=>s.latency_us),.5)/1000).toFixed(2)} ms; capture p50 ${(quantile(result.samples.map(s=>s.shadow_us),.5)/1000).toFixed(2)} ms`);
 }
}finally{s3.destroy();service.kill("SIGINT");const killed=setTimeout(()=>service.kill("SIGKILL"),3000);await service.exited;clearTimeout(killed);rmSync(`${artifacts}/s3`,{recursive:true,force:true});}
const summary=[...new Set(runs.map(r=>`${r.mode}/${r.flows}/${r.rowBytes}/${r.batch}/${r.capture}/${r.window}/${r.put_delay_ms}`))].map(key=>{
 const group=runs.filter(r=>`${r.mode}/${r.flows}/${r.rowBytes}/${r.batch}/${r.capture}/${r.window}/${r.put_delay_ms}`===key),first=group[0],samples=group.flatMap(r=>r.samples);
 const phases=Object.fromEntries(["latency_us","admission_us","primary_us","shadow_us","shadow_queued_us","encode_us","put_us","event_bytes"].map(key=>[key,stats(samples.map(s=>s[key as keyof Sample]))]));
 return {mode:first.mode,flows:first.flows,rowBytes:first.rowBytes,batch:first.batch,capture:first.capture,window:first.window,put_delay_ms:first.put_delay_ms,runs:group.length,initial_bytes:first.initial_bytes,setup_us:stats(group.map(r=>r.setup_us)),setup_disk_bytes:stats(group.map(r=>r.setup_disk_bytes)),final_files:first.final_files,rate:stats(group.map(r=>r.requests_per_second)),admitted_peak:Math.max(...group.map(r=>r.admitted_peak)),...phases};
});
const report={recorded_at:new Date().toISOString(),source_snapshot:system(["jj","log","-r","@","--no-graph","-T","commit_id"]),host:{cpu:system(["sysctl","-n","machdep.cpu.brand_string"]),memory_bytes:Number(system(["sysctl","-n","hw.memsize"]))},rust:system(["rustc","--version"]),turso:"0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88",redb:{version:"4.4.0",revision:system(["jj","log","-r","@","--no-graph","-T","commit_id"],resolve(root,"../../../cberner/redb.git/lts-4"))},profile:"bench (optimized)",s3:"go-faster/fs v0.15.0 over loopback",rounds,cpuGroups,s3Requests,s3Groups,s3WarmupGroups,delays_ms:delays,cache_bytes_per_engine:2*1024*1024,turso_fullfsync:Bun.env.DISK_FULLFSYNC==="1",summary};
writeFileSync(`${artifacts}/summary.json`,JSON.stringify(report,null,2)+"\n");console.log(`Results: ${artifacts}/summary.json`);
