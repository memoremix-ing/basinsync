import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ListObjectsV2Command} from "@aws-sdk/client-s3";
import {fixture,eventually} from "./analogue-fixture";
import {commit,form,epilogueStatus,reserveHeap,parseResponse,type HeapResponse} from "./client";
import { objectKeys } from "./object-keys";

delete Bun.env.BASINSYNC_LOG_FORMAT; // Exercise the server default independently of the invoking shell.
const f=await fixture("observability");
type Event={fields:Record<string,unknown>;span?:Record<string,unknown>;spans?:Record<string,unknown>[]};
const events=(path:string)=>readFileSync(path,"utf8").split("\n").filter(l=>l.startsWith("{")).map(l=>JSON.parse(l) as Event);
function value(text:string,name:string,labels:Record<string,string>={}):number {
  return text.split("\n").filter(l=>l.startsWith(name+"{")||l.startsWith(name+" ")).filter(l=>Object.entries(labels).every(([k,v])=>l.includes(`${k}="${v}"`))).reduce((sum,l)=>sum+Number(l.slice(l.lastIndexOf(" ")+1)),0);
}
async function scrape(url:string){const response=await fetch(`${url}/metrics`,{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);assert(response.headers.get("content-type")?.includes("version=0.0.4"));return response.text();}
try {
  const bucket=await f.bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let puts=0,s3Requests=0;
  const proxy=f.relay(async(request,next)=>{s3Requests++;if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)&&++puts===1){entered.resolve();await release.promise;}return next();});
  const app=await f.server(bucket,{RUST_LOG:"basinsync=debug",BASINSYNC_BATCH_MAX:"2",BASINSYNC_BATCH_WAIT_MS:"100"},proxy);
  const body=new TextEncoder().encode("opaque-observability-secret"),context={secret:"private-context-value"};
  const first=commit(app.url,"observed-a",body,0n,undefined,[],context),abort=new AbortController();
  const disconnected=fetch(`${app.url}/api/v0/epilogue`,{method:"PUT",body:form("observed-b",body,0n),signal:abort.signal}).then(()=>"response",()=>"disconnected");
  await entered.promise;
  const before=await scrape(app.url);
  assert.equal(value(before,"basinsync_submissions_inflight",{operation:"commit"}),2);
  assert.equal(value(before,"basinsync_batches_publishing"),1);
  assert.equal(value(before,"basinsync_submissions_total",{operation:"commit",outcome:"ok"}),0,"success cannot precede S3 durability");
  assert.equal(value(before,"basinsync_stage_seconds_count",{stage:"publish",operation:"timeline",outcome:"ok"}),0);
  const reads=s3Requests;await scrape(app.url);assert.equal(s3Requests,reads,"scraping must not probe S3 or enter the writer queue");
  abort.abort();assert.equal(await disconnected,"disconnected");release.resolve();
  const response=await first;assert.equal(response.status,201);const requestId=response.headers.get("x-request-id");assert(requestId);
  assert.equal((await epilogueStatus(app.url,"observed-b")).latest!.viewpoint,0n,"disconnection does not cancel admitted work");
  const after=await scrape(app.url);
  assert.equal(value(after,"basinsync_submissions_total",{operation:"commit",outcome:"ok"}),2);
  assert.equal(value(after,"basinsync_submissions_inflight",{operation:"commit"}),0);
  assert.equal(value(after,"basinsync_requests_queued",{operation:"commit"}),0);
  assert.equal(value(after,"basinsync_batches_publishing"),0);
  assert.equal(value(after,"basinsync_stage_seconds_count",{stage:"publish",operation:"timeline",outcome:"ok"}),1);
  assert.equal(value(after,"basinsync_stage_seconds_count",{stage:"acknowledgement",operation:"commit",outcome:"ok"}),2);
  const completed=events(app.log).filter(e=>e.fields.message==="submission completed"&&e.fields.outcome==="ok");
  assert.equal(completed.length,2);assert.equal(completed[0].fields.batch_id,completed[1].fields.batch_id);
  const requestSpans=completed.map(e=>e.span?.name==="request"?e.span:e.spans?.find(s=>s.name==="request"));
  assert(requestSpans.some(s=>s?.request_id===requestId));assert.equal(new Set(requestSpans.map(s=>s?.request_id)).size,2);
  assert(completed.every(e=>e.fields.milestone==="1"));
  assert.equal((await commit(app.url,"observed-a",body,0n)).status,409);
  assert.equal(value(await scrape(app.url),"basinsync_submissions_total",{operation:"commit",outcome:"rejected"}),1);
  const sampled=await eventually(()=>scrape(app.url),text=>value(text,"basinsync_background_pending",{space:"userspace",queue:"sweeping"})===2&&value(text,"basinsync_background_sample_timestamp_seconds")>0);
  assert.equal(value(sampled,"basinsync_background_pending",{space:"userspace",queue:"marking"}),2);
  assert(value(sampled,"basinsync_background_sample_timestamp_seconds")>0);
  const initialAge=value(sampled,"basinsync_background_oldest_age_seconds",{space:"userspace",queue:"sweeping"});
  await eventually(()=>scrape(app.url),text=>value(text,"basinsync_background_oldest_age_seconds",{space:"userspace",queue:"sweeping"})>initialAge);
  assert.equal((await f.s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:objectKeys.timeline}))).KeyCount,1,"sampling must not advance durable state");
  const token=new TextEncoder().encode("secret-access-token"),reserved=await parseResponse<HeapResponse>(await reserveHeap(app.url,"observed-a",1n,[{auth:[0,0,token],length:0,edges:[],context}]));
  assert(reserved.results?.[0].actions.write);
  for(let i=0;i<16;i++)assert.equal((await fetch(`${app.url}/unknown-${i}?credential=private-query-value`,{headers:{authorization:"Bearer private-auth-value"}})).status,404);
  await f.stop(app.process);
  const log=readFileSync(app.log,"utf8");
  for(const secret of ["opaque-observability-secret","private-context-value","secret-access-token",Buffer.from(token).toString("base64"),Buffer.from(token).toString("hex"),"private-query-value","private-auth-value","X-Amz-Signature",reserved.results![0].actions.write!.url])assert(!log.includes(secret),`sensitive data leaked: ${secret}`);
  const telemetry=after+sampled;
  for(const identifier of ["observed-a","observed-b",requestId,String(completed[0].fields.batch_id)])assert(!telemetry.includes(identifier),"identifiers belong in traces, not metric labels");
  const restarted=await f.server(bucket,{BASINSYNC_LOG_FORMAT:"text",RUST_LOG:"basinsync=debug"});
  const readyLine=readFileSync(restarted.log,"utf8").split("\n").find(line=>line.includes("ready"));assert(readyLine&&!readyLine.startsWith("{"),"explicit text logging remains supported");
  assert.equal(value(await scrape(restarted.url),"basinsync_submissions_total",{operation:"commit",outcome:"ok"}),0,"counters are process-local");
  await eventually(()=>scrape(restarted.url),text=>value(text,"basinsync_background_pending",{space:"userspace",queue:"sweeping"})===2&&value(text,"basinsync_background_sample_timestamp_seconds")>0);
  assert.equal((await epilogueStatus(restarted.url,"observed-a")).latest!.viewpoint,0n);await f.stop(restarted.process);
  // Failed publication must never emit a successful durable result.
  const failedBucket=await f.bucket(),failedProxy=f.relay(async(request,next)=>request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.timeline}`)?new Response("not stored",{status:503}):next());
  const failed=await f.server(failedBucket,{BASINSYNC_LOG_FORMAT:"json",RUST_LOG:"basinsync=debug"},failedProxy);
  assert.equal((await commit(failed.url,"failure",body,0n)).status,503);assert.equal(await failed.process.exited,1);
  const failures=events(failed.log).filter(e=>e.fields.message==="submission completed");assert.equal(failures.length,1);assert.equal(failures[0].fields.outcome,"failed");
  console.log(`put of success: durable trace correlation, disconnected requests, failed publication, live metrics during blocked S3, read-only backlog sampling, restart, bounded labels, and sensitive-data exclusion; ${f.artifacts}`);
}finally{await f.close();}
