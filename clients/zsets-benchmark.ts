import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { spawn, spawnSync } from "bun";

const root = resolve(import.meta.dir, "..");
mkdirSync(`${root}/.local`, {recursive:true});
const artifacts = mkdtempSync(`${root}/.local/zsets-benchmark-`);
const rounds=Number(Bun.env.ZSET_ROUNDS ?? 3);
const flowCounts=(Bun.env.ZSET_FLOW_COUNTS ?? "64,8192").split(",").map(Number);
const variants=(Bun.env.ZSET_VARIANTS ?? "baseline,app-reuse,point-read,hook-cache-record,hook-cache-values,cdc").split(",");
const cpuEvents=Number(Bun.env.ZSET_CPU_EVENTS ?? 512),s3Count=Number(Bun.env.ZSET_S3_COUNT ?? 256);
assert(Number.isInteger(rounds) && rounds>0 && cpuEvents>0 && s3Count>0 && s3Count%32===0);
type Sample={cpu_us:number;put_us:number;latency_us:number;event_bytes:number;logical_bytes:number;physical_bytes:number};
type Run={variant:string;mode:string;flows:number;batch:number;round:number;count:number;warmup:number;initial_sha384:string;initial_bytes:number;final_bytes:number;cache_init_us:number;cache_rows:number;cache_record_bytes:number;requests_per_second:number;samples:Sample[]};
async function run(command:string[],env:Record<string,string>,log:string){
 const p=spawn(command,{cwd:root,env:{...Bun.env,...env},stdout:"pipe",stderr:"pipe"});
 const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 writeFileSync(log,out+"\n"+err);assert.equal(code,0,`${log}\n${out.slice(-1800)}\n${err.slice(-1800)}`);return out;
}
function system(command:string[]){const r=spawnSync(command,{cwd:root});assert.equal(r.exitCode,0);return new TextDecoder().decode(r.stdout).trim();}
function quantile(values:number[],q:number){const sorted=values.toSorted((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*q)-1)];}
function stats(values:number[]){return {mean:values.reduce((a,b)=>a+b,0)/values.length,p50:quantile(values,.5),p95:quantile(values,.95),min:Math.min(...values),max:Math.max(...values)};}
console.log(`Z-set experiment artifacts: ${artifacts}`);
const build=await run(["cargo","test","--locked","--profile","bench","--lib","--no-run","--message-format=json"],{},`${artifacts}/build.log`);
const binary=build.split("\n").filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.reason==="compiler-artifact" && row.target.kind.includes("lib") && row.executable)?.executable;
assert(typeof binary==="string");
const socket=createServer();await new Promise<void>(yes=>socket.listen(0,"127.0.0.1",yes));
const address=socket.address();assert(address && typeof address!=="string");
const port=address.port;await new Promise<void>((yes,no)=>socket.close(e=>e?no(e):yes()));
const endpoint=`http://127.0.0.1:${port}`;
const credentials={accessKeyId:"zset-local",secretAccessKey:"zset-local-secret"};
const s3=new S3Client({endpoint,region:"us-east-1",forcePathStyle:true,credentials,maxAttempts:1});
const log=openSync(`${artifacts}/s3.log`,"w");
const service=spawn([Bun.env.FS_BIN ?? `${root}/.local/bin/fs`,"s3","--addr",`127.0.0.1:${port}`,"--root",`${artifacts}/s3`],{cwd:root,env:{...Bun.env,FS_ROOT_ACCESS_KEY:credentials.accessKeyId,FS_ROOT_SECRET_KEY:credentials.secretAccessKey},stdout:log,stderr:log});closeSync(log);
const runs:Run[]=[];
try {
 const deadline=Date.now()+15000;
 for(;;){try{await s3.send(new CreateBucketCommand({Bucket:"zset-ready"}));break}catch(e){if(Date.now()>deadline)throw e;await Bun.sleep(30)}}
 for(const mode of (Bun.env.ZSET_MODES ?? "cpu,s3").split(","))for(let round=0;round<rounds;round++)for(const flows of (mode==="s3"?[flowCounts.at(-1)!]:(round%2?flowCounts.toReversed():flowCounts)))for(const batch of (round%2?[32,1]:[1,32]))for(let i=0;i<variants.length;i++){
  const variant=variants[(i+round)%variants.length];
  const name=`${mode}-r${round}-${flows}-b${batch}-${variant}`;
  const bucket=`zset-${name}`;
  if(mode==="s3")await s3.send(new CreateBucketCommand({Bucket:bucket}));
  const count=mode==="cpu"?cpuEvents*batch:s3Count;
  const warmup=mode==="cpu"?64*batch:64;
  await run([binary,"--exact","turso::wal::zsets::measure","--ignored","--nocapture","--test-threads=1"],{
   ZSET_VARIANT:variant,ZSET_MODE:mode,ZSET_FLOWS:String(flows),ZSET_BATCH:String(batch),ZSET_COUNT:String(count),ZSET_WARMUP:String(warmup),ZSET_OUTPUT:`${artifacts}/${name}.json`,S3_ENDPOINT:endpoint,S3_BUCKET:bucket,AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,
  },`${artifacts}/${name}.log`);
  const result=JSON.parse(readFileSync(`${artifacts}/${name}.json`,"utf8")) as Run;
  result.mode=mode;result.round=round;
  assert.equal(result.samples.length,count/batch);
  assert(result.samples.every(s=>s.cpu_us>0 && s.event_bytes>0 && Number.isFinite(s.cpu_us)));
  const prior=runs.find(r=>r.flows===flows && (r.variant==="cdc")===(variant==="cdc"));if(prior)assert.equal(prior.initial_sha384,result.initial_sha384);
  if(mode==="s3"){let count=0,token:string|undefined;do{const page=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:"timeline/",ContinuationToken:token}));count+=(page.Contents??[]).length;token=page.NextContinuationToken;}while(token);assert.equal(count,(result.count+result.warmup)/batch);}
  runs.push(result);
  writeFileSync(`${artifacts}/samples.json`,JSON.stringify(runs));
  console.log(`${name}: CPU p50 ${quantile(result.samples.map(s=>s.cpu_us),.5).toFixed(1)} us; ${result.requests_per_second.toFixed(1)} requests/s; ${quantile(result.samples.map(s=>s.event_bytes),.5)} bytes/event`);
 }
}finally{
 s3.destroy();service.kill("SIGINT");const killed=setTimeout(()=>service.kill("SIGKILL"),3000);await service.exited;clearTimeout(killed);rmSync(`${artifacts}/s3`,{recursive:true,force:true});
}
const summary=[...new Set(runs.map(r=>`${r.mode}/${r.flows}/${r.batch}/${r.variant}`))].map(key=>{
 const group=runs.filter(r=>`${r.mode}/${r.flows}/${r.batch}/${r.variant}`===key),first=group[0];
 const samples=group.flatMap(r=>r.samples);
 return {mode:first.mode,flows:first.flows,batch:first.batch,variant:first.variant,runs:group.length,samples:samples.length,initial_bytes:first.initial_bytes,final_bytes:stats(group.map(r=>r.final_bytes)),cache_init_us:stats(group.map(r=>r.cache_init_us)),cache_rows:first.cache_rows,cache_record_bytes:first.cache_record_bytes,rate:stats(group.map(r=>r.requests_per_second)),cpu_us:stats(samples.map(s=>s.cpu_us)),latency_us:stats(samples.map(s=>s.latency_us)),event_bytes:stats(samples.map(s=>s.event_bytes)),logical_bytes:stats(samples.map(s=>s.logical_bytes)),physical_bytes:stats(samples.map(s=>s.physical_bytes))};
});
const report={recorded_at:new Date().toISOString(),source_snapshot:system(["jj","log","-r","@","--no-graph","-T","commit_id"]),host:{cpu:system(["sysctl","-n","machdep.cpu.brand_string"]),memory_bytes:Number(system(["sysctl","-n","hw.memsize"]))},rust:system(["rustc","--version"]),turso:"0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88",profile:"bench (optimized)",s3:"go-faster/fs v0.15.0 over loopback",rounds,cpuEvents,s3Count,summary};
writeFileSync(`${artifacts}/summary.json`,JSON.stringify(report,null,2)+"\n");
console.log(`Results: ${artifacts}/summary.json`);
