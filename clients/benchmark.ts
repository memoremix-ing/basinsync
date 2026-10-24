import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { CreateBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { spawn, spawnSync } from "bun";

const root = resolve(import.meta.dir, "..");
mkdirSync(`${root}/.local`, {recursive:true});
const artifacts = mkdtempSync(`${root}/.local/benchmark-0003-`);
const commits = Number(Bun.env.BENCH_COMMITS ?? 500);
const warmup = Number(Bun.env.BENCH_WARMUP ?? 100);
const rounds = Number(Bun.env.BENCH_ROUNDS ?? 6);
const flowCounts = (Bun.env.BENCH_FLOW_COUNTS ?? "64,8192").split(",").map(Number);
const blobBytes = Number(Bun.env.BENCH_BLOB_BYTES ?? 4096);
assert([commits,rounds,...flowCounts].every(n => Number.isSafeInteger(n) && n > 0));
assert(Number.isSafeInteger(warmup) && warmup >= 0);
assert(Number.isSafeInteger(blobBytes) && blobBytes >= 0);
type Variant = "builtin" | "capture" | "capture-s3";
type Sample = {variant:Variant; milestone:number; total_us:number; phases_us:Record<string,number>; database_bytes:number; event_bytes:number};
type Run = {schema:number;variant:Variant;turso_version:string;commits:number;warmup:number;flows:number;blob_bytes:number;initial_database_bytes:number;initial_database_sha384:string;samples:Sample[];round:number};
const orders: Variant[][] = [
  ["builtin","capture","capture-s3"], ["capture","capture-s3","builtin"], ["capture-s3","builtin","capture"],
  ["builtin","capture-s3","capture"], ["capture-s3","capture","builtin"], ["capture","builtin","capture-s3"],
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
console.log(`Benchmark artifacts: ${artifacts}`);
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
  for(;;) {
    assert.equal(service.exitCode,null,"S3 service exited");
    try {await s3.send(new CreateBucketCommand({Bucket:"benchmark-ready"}));break;} catch(e) {if(Date.now()>deadline)throw e;await Bun.sleep(30);}
  }
  for(const flows of flowCounts) {
    await run([binary,"--exact","turso::benchmark::seed","--ignored","--nocapture"],{
      BENCH_FLOWS:String(flows),BENCH_SEED_IMAGE:`${artifacts}/seed-${flows}.turso`,BENCH_SEED_EVENT:`${artifacts}/seed-${flows}.event`,
    },`${artifacts}/seed-${flows}.log`);
  }
  for(let round=0;round<rounds;round++) {
    for(const flows of (round%2===0?flowCounts:flowCounts.toReversed())) {
      for(const variant of orders[round%orders.length]) {
        const name=`r${round}-${flows}-${variant}`;
        const bucket=`benchmark-${name}`;
        if(variant==="capture-s3") {
          await s3.send(new CreateBucketCommand({Bucket:bucket}));
          await s3.send(new PutObjectCommand({Bucket:bucket,Key:"timeline/0w1z",Body:readFileSync(`${artifacts}/seed-${flows}.event`),IfNoneMatch:"*"}));
        }
        await run([binary,"--exact","turso::benchmark::commits","--ignored","--nocapture","--test-threads=1"],{
          BENCH_VARIANT:variant,BENCH_COMMITS:String(commits),BENCH_WARMUP:String(warmup),BENCH_FLOWS:String(flows),BENCH_BLOB_BYTES:String(blobBytes),
          BENCH_OUTPUT:`${artifacts}/${name}.json`,BENCH_SEED_IMAGE:`${artifacts}/seed-${flows}.turso`,
          S3_ENDPOINT:endpoint,S3_BUCKET:bucket,AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,
        },`${artifacts}/${name}.log`);
        const result=JSON.parse(readFileSync(`${artifacts}/${name}.json`,"utf8")) as Run;
        result.round=round;
        assert.equal(result.samples.length,commits);
        assert(result.samples.every(s=>s.total_us>0 && Number.isFinite(s.total_us)));
        const previous=runs.find(r=>r.flows===flows);
        if(previous)assert.equal(result.initial_database_sha384,previous.initial_database_sha384,"all variants must start from identical database bytes");
        if(variant==="capture-s3") {
          let count=0, token:string|undefined;
          do {
            const page=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:"timeline/",ContinuationToken:token}));
            count+=(page.Contents??[]).length;token=page.NextContinuationToken;
          } while(token);
          assert.equal(count,commits+warmup+1,"every conditional PUT stored one event");
        }
        runs.push(result);
        console.log(`${name}: ${(1e6/stats(result.samples.map(s=>s.total_us)).mean).toFixed(0)} commits/s; p50 ${quantile(result.samples.map(s=>s.total_us),.5).toFixed(1)} us`);
      }
    }
  }
} finally {
  s3.destroy();
  service.kill("SIGINT");
  const killed=setTimeout(()=>service.kill("SIGKILL"),3000);
  await service.exited;clearTimeout(killed);
  rmSync(`${artifacts}/s3`,{recursive:true,force:true});
}
const summary=flowCounts.flatMap(flows=>(["builtin","capture","capture-s3"] as Variant[]).map(variant=>{
  const group=runs.filter(r=>r.flows===flows && r.variant===variant);
  const samples=group.flatMap(r=>r.samples);
  const phaseNames=[...new Set(samples.flatMap(s=>Object.keys(s.phases_us)))];
  return {flows,variant,samples:samples.length,database_bytes:stats(samples.map(s=>s.database_bytes)),event_bytes:stats(samples.map(s=>s.event_bytes)),
    latency_us:stats(samples.map(s=>s.total_us)),run_commits_per_second:stats(group.map(r=>1e6/stats(r.samples.map(s=>s.total_us)).mean)),
    phases_us:Object.fromEntries(phaseNames.map(name=>[name,stats(samples.map(s=>s.phases_us[name]??0))])),
  };
}));
const report={schema:1,recorded_at:new Date().toISOString(),source_snapshot:system(["jj","log","-r","@","--no-graph","-T","commit_id"]),host:{cpu_brand:system(["sysctl","-n","machdep.cpu.brand_string"]),uname:system(["uname","-a"]),model:system(["sysctl","-n","hw.model"]),memory_bytes:Number(system(["sysctl","-n","hw.memsize"])),logical_cpus:Number(system(["sysctl","-n","hw.logicalcpu"]))},
  toolchain:{rust:system(["rustc","--version"]),bun:Bun.version,fs:"github.com/go-faster/fs v0.15.0",profile:"bench (optimized)",turso:runs[0].turso_version},
  commits,warmup,rounds,flow_counts:flowCounts,blob_bytes:blobBytes,concurrency:1,endpoint:"local go-faster/fs over HTTP loopback",summary};
writeFileSync(`${artifacts}/summary.json`,JSON.stringify(report,null,2)+"\n");
const phaseNames=[...new Set(runs.flatMap(r=>r.samples.flatMap(s=>Object.keys(s.phases_us))))].sort();
const header=["flows","round","variant","milestone","total_us","database_bytes","event_bytes",...phaseNames.map(p=>`${p}_us`)];
writeFileSync(`${artifacts}/samples.csv`,header.join(",")+"\n"+runs.flatMap(r=>r.samples.map(s=>[r.flows,r.round,s.variant,s.milestone,s.total_us,s.database_bytes,s.event_bytes,...phaseNames.map(p=>s.phases_us[p]??0)].join(","))).join("\n")+"\n");
console.log(JSON.stringify(summary.map(s=>({flows:s.flows,variant:s.variant,commits_s:s.run_commits_per_second.p50,p50_us:s.latency_us.p50,p95_us:s.latency_us.p95,p99_us:s.latency_us.p99})),null,2));
console.log(`Results: ${artifacts}/summary.json`);
