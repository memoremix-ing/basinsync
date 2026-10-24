import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { CreateBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { spawn, spawnSync } from "bun";

const root = resolve(import.meta.dir, "..");
mkdirSync(`${root}/.local`, {recursive:true});
const artifacts = mkdtempSync(`${root}/.local/wal-experiments-`);
const rounds=Number(Bun.env.EXP_ROUNDS ?? 3);
const flowCounts=(Bun.env.EXP_FLOW_COUNTS ?? "64,8192").split(",").map(Number);
const cpuCount=Number(Bun.env.EXP_CPU_COUNT ?? 512), cpuWarmup=64;
const s3Count=Number(Bun.env.EXP_S3_COUNT ?? 256), s3Warmup=64;
assert(Number.isInteger(rounds) && rounds>0);
assert(s3Count>0 && s3Count%32===0 && cpuCount>0);
type Config={engine:string;mode:string;batch:number};
type Row={latency_us:number;put_us?:number;requests?:number;event_bytes:number;completed_us?:number};
type Run=Config&{flows:number;round:number;count:number;warmup:number;initial_sha384:string;initial_bytes:number;requests_per_second?:number;samples:Row[]};
const cpu:Config[]=["image-verify","image-no-replay","wal-copy-hashed","wal-copy","wal-live","wal-vector"].map(engine=>({engine,mode:"cpu",batch:1}));
const recovery:Config[]=[{engine:"image-verify",mode:"recover-full",batch:1},{engine:"wal-live",mode:"recover-full",batch:1},{engine:"wal-live",mode:"recover-sparse",batch:1}];
recovery.push({engine:"wal-vector",mode:"recover-sparse",batch:1});
const s3configs:Config[]=[
 {engine:"image-verify",mode:"serial",batch:1},{engine:"image-verify",mode:"pipeline",batch:1},
 ...["wal-live","wal-vector"].flatMap(engine=>[1,8,32].flatMap(batch=>["serial","pipeline"].map(mode=>({engine,mode,batch})))),
];
async function run(command:string[], env:Record<string,string>, logPath:string):Promise<string> {
  const p = spawn(command, {cwd:root,env:{...Bun.env,...env},stdout:"pipe",stderr:"pipe"});
  const [out,err,code] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  writeFileSync(logPath, out+"\n"+err);
  assert.equal(code,0,`command failed: ${command.join(" ")}; ${logPath}\n${err.slice(-3000)}\n${out.slice(-3000)}`);
  return out;
}
function system(command:string[]) {
  const r = spawnSync(command,{cwd:root}); assert.equal(r.exitCode,0);
  return new TextDecoder().decode(r.stdout).trim();
}
function quantile(values:number[], q:number) {
  const sorted = values.toSorted((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*q)-1)];
}
function stats(values:number[]) {
  return {mean:values.reduce((a,b)=>a+b,0)/values.length,p50:quantile(values,.5),p95:quantile(values,.95),p99:quantile(values,.99),min:Math.min(...values),max:Math.max(...values)};
}
console.log(`Experiment artifacts: ${artifacts}`);
if (!Bun.env.FS_BIN && !existsSync(`${root}/.local/bin/fs`)) {
  mkdirSync(`${root}/.local/bin`,{recursive:true});
  await run(["go","install","github.com/go-faster/fs/cmd/fs@v0.15.0"],{GOBIN:`${root}/.local/bin`},`${artifacts}/fs-build.log`);
}
console.log("Building optimized benchmark harness (outside measured intervals)...");
const build = await run(["cargo","test","--locked","--profile","bench","--lib","--no-run","--message-format=json"],{},`${artifacts}/build.log`);
const binary = build.split("\n").filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.reason==="compiler-artifact" && row.target.kind.includes("lib") && row.executable)?.executable;
assert(typeof binary === "string", "benchmark executable not found");
const socket = createServer(); await new Promise<void>(yes=>socket.listen(0,"127.0.0.1",yes));
const address=socket.address(); assert(address && typeof address!=="string");
const port=address.port; await new Promise<void>((yes,no)=>socket.close(err=>err?no(err):yes()));
const endpoint=`http://127.0.0.1:${port}`;
const credentials={accessKeyId:"benchmark-local",secretAccessKey:"benchmark-local-secret"};
const s3 = new S3Client({endpoint,region:"us-east-1",forcePathStyle:true,credentials,maxAttempts:1});
const log = openSync(`${artifacts}/s3.log`,"w");
const service=spawn([Bun.env.FS_BIN ?? `${root}/.local/bin/fs`,"s3","--addr",`127.0.0.1:${port}`,"--root",`${artifacts}/s3`],{
  cwd:root,env:{...Bun.env,FS_ROOT_ACCESS_KEY:credentials.accessKeyId,FS_ROOT_SECRET_KEY:credentials.secretAccessKey},stdout:log,stderr:log,
}); closeSync(log);
const runs:Run[]=[];
try {
 const deadline=Date.now()+15000;
 for(;;){try{await s3.send(new CreateBucketCommand({Bucket:"experiment-ready"}));break}catch(e){if(Date.now()>deadline)throw e;await Bun.sleep(30)}}
 for(const flows of flowCounts)await run([binary,"--exact","turso::benchmark::seed","--ignored","--nocapture"],{
  BENCH_FLOWS:String(flows),BENCH_SEED_IMAGE:`${artifacts}/seed-${flows}.turso`,BENCH_SEED_EVENT:`${artifacts}/seed-${flows}.event`,
 },`${artifacts}/seed-${flows}.log`);
 for(const configs of [[...cpu,...recovery],s3configs].map(configs=>configs.filter(c=>!Bun.env.EXP_ENGINES || Bun.env.EXP_ENGINES.split(",").includes(c.engine))))for(let round=0;round<rounds;round++)for(const flows of (round%2?flowCounts.toReversed():flowCounts)){
  const order=configs.map((_,i)=>configs[(i+round)%configs.length]);
  for(const config of order){
   const isCpu=(config.mode==="cpu" || config.mode.startsWith("recover-"));
   const name=`r${round}-${flows}-${config.engine}-${config.mode}-b${config.batch}`;
   const bucket=`experiment-${name}`;
   if(!isCpu){
    await s3.send(new CreateBucketCommand({Bucket:bucket}));
    await s3.send(new PutObjectCommand({Bucket:bucket,Key:"timeline/0w1z",Body:readFileSync(`${artifacts}/seed-${flows}.event`),IfNoneMatch:"*"}));
   }
   await run([binary,"--exact","turso::experiments::measure","--ignored","--nocapture","--test-threads=1"],{
    EXP_ENGINE:config.engine,EXP_MODE:config.mode,EXP_BATCH:String(config.batch),EXP_FLOWS:String(flows),EXP_COUNT:String(isCpu?cpuCount:s3Count),EXP_WARMUP:String(isCpu?cpuWarmup:s3Warmup),EXP_OUTPUT:`${artifacts}/${name}.json`,BENCH_SEED_IMAGE:`${artifacts}/seed-${flows}.turso`,
    S3_ENDPOINT:endpoint,S3_BUCKET:bucket,AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,
   },`${artifacts}/${name}.log`);
   const result=JSON.parse(readFileSync(`${artifacts}/${name}.json`,"utf8")) as Run;result.round=round;
   assert.equal(result.samples.length,result.count/config.batch);
   assert(result.samples.every(s=>s.latency_us>0 && Number.isFinite(s.latency_us)));
   const prior=runs.find(r=>r.flows===flows);if(prior)assert.equal(result.initial_sha384,prior.initial_sha384);
   if(!isCpu){let count=0,token:string|undefined;do{const page=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:"timeline/",ContinuationToken:token}));count+=(page.Contents??[]).length;token=page.NextContinuationToken}while(token);assert.equal(count,(result.count+result.warmup)/config.batch+1)}
   runs.push(result);
   const rate=isCpu?1e6/stats(result.samples.map(s=>s.latency_us)).mean:result.requests_per_second!;
   console.log(`${name}: ${rate.toFixed(1)} requests/s; p50 ${(quantile(result.samples.map(s=>s.latency_us),.5)/1000).toFixed(3)} ms`);
  }
 }
}finally{
 s3.destroy();service.kill("SIGINT");const killed=setTimeout(()=>service.kill("SIGKILL"),3000);await service.exited;clearTimeout(killed);rmSync(`${artifacts}/s3`,{recursive:true,force:true});
}
const summary=flowCounts.flatMap(flows=>[...cpu,...recovery,...s3configs].filter(c=>!Bun.env.EXP_ENGINES || Bun.env.EXP_ENGINES.split(",").includes(c.engine)).map(config=>{
 const group=runs.filter(r=>r.flows===flows && r.engine===config.engine && r.mode===config.mode && r.batch===config.batch);
 const samples=group.flatMap(r=>r.samples);
 return {...config,flows,runs:group.length,object_samples:samples.length,requests:samples.reduce((n,s)=>n+(s.requests??1),0),image_bytes:group[0].initial_bytes,
  latency_us:stats(samples.map(s=>s.latency_us)),rate:stats(group.map(r=>r.requests_per_second??1e6/stats(r.samples.map(s=>s.latency_us)).mean)),event_bytes:stats(samples.map(s=>s.event_bytes)),put_us:(config.mode==="cpu" || config.mode.startsWith("recover-"))?null:stats(samples.map(s=>s.put_us!)),
 };
}));
const report={recorded_at:new Date().toISOString(),source_snapshot:system(["jj","log","-r","@","--no-graph","-T","commit_id"]),host:{cpu:system(["sysctl","-n","machdep.cpu.brand_string"]),memory_bytes:Number(system(["sysctl","-n","hw.memsize"])),logical_cpus:Number(system(["sysctl","-n","hw.logicalcpu"]))},turso:"0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88",rust:system(["rustc","--version"]),profile:"bench (optimized)",s3:"go-faster/fs v0.15.0 over loopback",rounds,cpuCount,cpuWarmup,s3Count,s3Warmup,summary};
writeFileSync(`${artifacts}/summary.json`,JSON.stringify(report,null,2)+"\n");
writeFileSync(`${artifacts}/samples.json`,JSON.stringify(runs));
console.log(`Results: ${artifacts}/summary.json`);
