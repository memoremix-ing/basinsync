import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import {cpus,platform,release,totalmem} from "node:os";
import {HeadObjectCommand,ListObjectsV2Command,PutObjectCommand} from "@aws-sdk/client-s3";
import {fixture,eventually} from "./analogue-fixture";
import {encodeBulkOrder,decodeBulkOrder,key} from "./bulkorder";
import {commit} from "./client";
import { objectKeys } from "./object-keys";

const f=await fixture("recovery-benchmark"),rounds=Number(Bun.env.RECOVERY_BENCH_ROUNDS??2),count=Number(Bun.env.RECOVERY_BENCH_EVENTS??96);
const modes=(Bun.env.RECOVERY_BENCH_MODES??"sequential,parallel,bulk,range,hedged,bulk-parallel,range-parallel,range-prefetch").split(","),profiles=[{name:"local",delay:0,bandwidth:Infinity},{name:"25ms",delay:25,bandwidth:Infinity},{name:"100ms",delay:100,bandwidth:Infinity},{name:"25ms-5MiBps",delay:25,bandwidth:5*1024*1024}].filter(p=>!Bun.env.RECOVERY_BENCH_PROFILES||Bun.env.RECOVERY_BENCH_PROFILES.split(",").includes(p.name));
const archivedCount=Number(Bun.env.RECOVERY_BENCH_ARCHIVED_EVENTS??count);
const samples:Record<string,unknown>[]=[],foreground:Record<string,unknown>[]=[];
let delay=0,bandwidth=Infinity,nextTransfer=0,bytes=0,active=0,peak=0,requests:Record<string,number>={};
const proxy=f.relay(async(request,next)=>{
  active++;peak=Math.max(peak,active);const url=new URL(request.url),kind=url.searchParams.has("list-type")?`LIST ${url.searchParams.get("prefix")??""}`:`${request.method} ${url.pathname.includes(`/${objectKeys.timeline}`)?"timeline":url.pathname.includes(`/${objectKeys.analogue}`)?"analogue":"other"}`;
  requests[kind]=(requests[kind]??0)+1;
  try{const response=await next(),body=new Uint8Array(await response.arrayBuffer());bytes+=body.length;
    const now=performance.now(),transfer=Number.isFinite(bandwidth)?body.length/bandwidth*1000:0;nextTransfer=Math.max(now,nextTransfer)+transfer;const wait=delay+nextTransfer-now;if(wait>0)await Bun.sleep(wait);
    return new Response(request.method==="HEAD"||[204,304].includes(response.status)?null:body,{status:response.status,headers:response.headers});
  }finally{active--;}
});
function reset(){assert.equal(active,0);bytes=0;peak=0;requests={};nextTransfer=0;}
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
try{
  const events=await f.generate(count,32768),checkpoints=Bun.env.RECOVERY_BENCH_CHECKPOINT?[Number(Bun.env.RECOVERY_BENCH_CHECKPOINT)]:[0,Math.floor(count*3/4)],datasets=[];
  for(const checkpoint of checkpoints){
    const bucket=await f.bucket();await f.seed(bucket,events.slice(0,checkpoint||events.length));
    if(checkpoint){
      await f.checkpoint(bucket,events.slice(0,checkpoint));await f.seed(bucket,events.slice(checkpoint),checkpoint+1);
    }
    let low=1,group:Uint8Array[]=[],size=0,orders=0;
    async function flush(){if(!group.length)return;const body=encodeBulkOrder(BigInt(low),group),{range,index}=decodeBulkOrder(body),high=low+group.length;await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:key(BigInt(low),BigInt(high),range.start,index.coordinate),Body:body,Metadata:{"bulkmanifest-range":`bytes=${range.start}-${range.end-1}`}}));orders++;low=high;group=[];size=0;}
    if(Bun.env.RECOVERY_BENCH_OVERLAP==="staggered"){
      for(let first=1;first<=count;first+=16){const high=Math.min(count+1,first+24),body=encodeBulkOrder(BigInt(first),events.slice(first-1,high-1)),{range,index}=decodeBulkOrder(body);await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:key(BigInt(first),BigInt(high),range.start,index.coordinate),Body:body,Metadata:{"bulkmanifest-range":`bytes=${range.start}-${range.end-1}`}}));orders++;if(high===count+1)break;}
    }else{for(const event of events.slice(0,archivedCount)){group.push(event);size+=event.length;if(size>=5*1024*1024)await flush();}await flush();}
    if(Bun.env.RECOVERY_BENCH_OVERLAP&&Bun.env.RECOVERY_BENCH_OVERLAP!=="staggered"){const body=encodeBulkOrder(1n,events),{range,index}=decodeBulkOrder(body);await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:key(1n,BigInt(count+1),range.start,index.coordinate),Body:body,Metadata:{"bulkmanifest-range":`bytes=${range.start}-${range.end-1}`}}));orders++;}
    const expected=await f.recover(bucket,"sequential");datasets.push({bucket,checkpoint,expected:expected.sha384,orders});
  }
  for(const profile of profiles){delay=profile.delay;bandwidth=profile.bandwidth;
    for(const dataset of datasets)for(let round=0;round<rounds;round++){
      const order=[...modes.slice(round%modes.length),...modes.slice(0,round%modes.length)];
      for(const mode of order){reset();const variant=mode.match(/^(bulk-parallel|range-parallel|range-prefetch)-(\d+)$/);const extra:Record<string,string>=variant?{[variant[1]==="range-prefetch"?"BASINSYNC_RECOVERY_MANIFEST_CONCURRENCY":"BASINSYNC_RECOVERY_BULK_CONCURRENCY"]:variant[2]}:{};const result=await f.recover(dataset.bucket,variant?.[1]??mode,proxy,true,extra);assert.equal(result.sha384,dataset.expected);assert.equal(result.milestone,String(count));
        // A finished recovery may have cancelled speculative read-only requests at the proxy.
        await eventually(async()=>active,n=>n===0);
        samples.push({profile:profile.name,checkpoint:dataset.checkpoint,orders:dataset.orders,round,mode,...result,bytes,requests:{...requests},peak_requests:peak});
      }
    }
    console.log(`measured recovery ${profile.name}`);
  }
  delay=25;bandwidth=Infinity;
  for(let round=0;round<(Bun.env.RECOVERY_BENCH_SKIP_FOREGROUND?0:3);round++)for(const target of [0,5242880,524288].slice(round).concat([0,5242880,524288].slice(0,round))){
    const bucket=await f.bucket(),app=await f.server(bucket,{BASINSYNC_BATCH_MAX:"32",BASINSYNC_BATCH_WAIT_MS:"2",BASINSYNC_BULK_MAX_AGE_MS:target?"30000":"0",BASINSYNC_BULK_TARGET_BYTES:String(target||5242880)},proxy,true);
    reset();const latencies:number[]=[],started=performance.now();
    await Promise.all(Array.from({length:4},async(_,lane)=>{for(let n=0;n<32;n++){const start=performance.now(),response=await commit(app.url,`lane-${lane}`,new Uint8Array(65536).fill(n),BigInt(n));assert.equal(response.status,201);await response.arrayBuffer();latencies.push(performance.now()-start);}}));
    const elapsed=performance.now()-started;foreground.push({round,target,requests_per_second:128/(elapsed/1000),p50_ms:percentile(latencies,.5),p95_ms:percentile(latencies,.95),timeline_gets:requests["GET timeline"]??0,bulk_puts:requests["PUT analogue"]??0,peak_requests:peak});
    await f.stop(app.process);await eventually(async()=>active,n=>n===0);
  }
  const report={recorded_at:new Date().toISOString(),machine:{cpu:cpus()[0].model,platform:platform(),release:release(),memory:totalmem()},rounds,count,archived_count:archivedCount,overlap:Bun.env.RECOVERY_BENCH_OVERLAP??false,blob_bytes:32768,event_bytes:events.reduce((n,e)=>n+e.length,0),profiles:profiles.map(p=>({...p,bandwidth:Number.isFinite(p.bandwidth)?p.bandwidth:null})),samples,foreground};
  writeFileSync(`${f.artifacts}/samples.json`,JSON.stringify(report,null,2));
  const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return (sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(sorted.length/2)])/2;};
  const summary=[];for(const profile of profiles)for(const checkpoint of checkpoints)for(const mode of modes){const rows=samples.filter(s=>s.profile===profile.name&&s.checkpoint===checkpoint&&s.mode===mode);summary.push({profile:profile.name,checkpoint,mode,median_ms:median(rows.map(r=>r.elapsed_ms as number)),median_bytes:median(rows.map(r=>r.bytes as number)),requests:rows[0].requests,stats:rows[0].stats});}
  writeFileSync(`${f.artifacts}/summary.json`,JSON.stringify({summary,foreground},null,2));console.log(JSON.stringify({artifacts:f.artifacts,summary,foreground}));
}finally{await f.close();}
