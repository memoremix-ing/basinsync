import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {GetObjectCommand,HeadObjectCommand,ListObjectsV2Command,PutObjectCommand,DeleteObjectCommand} from "@aws-sdk/client-s3";
import {fixture,eventually} from "./analogue-fixture";
import {key as indexedKey,fromKey,encodeBulkOrder,decodeBulkOrder,boundary} from "./bulkorder";
import {key as timelineKey,fromKey as timelineFromKey} from "./timeline";
import {rangesAt,trimRetryMargins} from "./events";
import {at,concat,wrap,MARGIN} from "./envbuf";
import {commit} from "./client";
import { objectKeys } from "./object-keys";

const f=await fixture();
try{
  const events=await f.generate(64,4096),bucket=await f.bucket();await f.seed(bucket,events);
  function key(low:bigint,high:bigint){const body=encodeBulkOrder(low,events.slice(Number(low-1n),Number(high-1n)));const decoded=decodeBulkOrder(body);return indexedKey(low,high,decoded.range.start,decoded.index.coordinate);}
  // Independent Rust/TS writers and readers, including short bigint payloads.
  for(const lowest of [1n,42n,65535n,1n<<256n]){
    const selected=events.slice(0,4),ts=encodeBulkOrder(lowest,selected);
    const rustIndex=JSON.parse(new TextDecoder().decode(await f.binary(["--decode"],{},ts)));
    const rust=await f.binary(["--pack",String(lowest)],{},concat(selected)),decoded=decodeBulkOrder(rust);
    assert.equal(decoded.index.lowest,lowest);assert.deepEqual(decoded.events,selected.map(trimRetryMargins));assert.deepEqual(decoded.index.ends,rustIndex.ends);
  }
  const baseline=await f.recover(bucket,"sequential");assert.equal(baseline.milestone,"64");
  async function put(low:number,high:number,bytes=encodeBulkOrder(BigInt(low),events.slice(low-1,high-1))){const {range}=decodeBulkOrder(bytes);await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:key(BigInt(low),BigInt(high)),Body:bytes,Metadata:{"bulkmanifest-range":`bytes=${range.start}-${range.end-1}`}}));}
  await put(1,9);await put(1,25);await put(9,41);await put(17,65);
  const calls:{method:string;url:URL}[]=[];
  const traced=f.relay(async(request,next)=>{
    const url=new URL(request.url);calls.push({method:request.method,url});const response=await next();
    if(url.searchParams.get("prefix")===objectKeys.analogue){
      const text=await response.text(),contents=[...text.matchAll(/<Contents>.*?<\/Contents>/gs)];
      if(contents.length>1){let first=true;const paged=text.replace(/<Contents>.*?<\/Contents>/gs,match=>{if(first){first=false;return match;}return "";}).replace(/<IsTruncated>.*?<\/IsTruncated>/,"<IsTruncated>true</IsTruncated>").replace(/<KeyCount>.*?<\/KeyCount>/,"<KeyCount>1</KeyCount>");const headers=new Headers(response.headers);headers.delete("content-length");return new Response(paged,{status:response.status,headers});}
      return new Response(text,{status:response.status,headers:response.headers});
    }
    return response;
  });
  for(const mode of ["default","parallel","bulk","range","hedged","bulk-parallel","range-parallel","range-prefetch","bidirectional"]){
    calls.length=0;const restored=await f.recover(bucket,mode,traced);assert.equal(restored.sha384,baseline.sha384);assert.equal(restored.coordinate,baseline.coordinate);assert.equal(restored.crc32c,baseline.crc32c);assert.deepEqual(restored.flows,baseline.flows);
    if(mode!=="parallel")assert(calls.some(c=>c.method==="GET"&&c.url.pathname.includes(`/${objectKeys.analogue}`)),`${mode} used BulkOrders`);
    if(mode==="range"||mode==="range-parallel"||mode==="range-prefetch")assert(!calls.some(c=>c.method==="HEAD"&&c.url.pathname.includes(`/${objectKeys.analogue}`)),"key locates the manifest without HEAD");
    const singles=calls.filter(c=>c.method==="GET"&&c.url.pathname.includes(`/${objectKeys.timeline}`)).length;
    if(mode==="bulk"||mode==="range")assert(singles<events.length/2,`reduced Timeline GETs: ${singles}`);
  }
  // Different FlexBuffers layouts share a key when their event bytes agree.
  {
    const b=await f.bucket();await f.seed(b,events);
    const original=encodeBulkOrder(1n,events),a=decodeBulkOrder(original),footer=at(original,a.range.start);
    const alternative=concat([...a.events,wrap(concat([new Uint8Array(8),footer.content])),wrap(new Uint8Array(8),MARGIN)]),decoded=decodeBulkOrder(alternative),name=indexedKey(1n,65n,decoded.range.start,decoded.index.coordinate);
    assert.notEqual(decoded.range.end,a.range.end);assert.equal(name,indexedKey(1n,65n,a.range.start,a.index.coordinate));
    await f.s3.send(new PutObjectCommand({Bucket:b,Key:name,Body:alternative,IfNoneMatch:"*",Metadata:{"bulkmanifest-range":`bytes=${decoded.range.start}-${decoded.range.end-1}`}}));
    await assert.rejects(()=>f.s3.send(new PutObjectCommand({Bucket:b,Key:indexedKey(1n,65n,a.range.start,a.index.coordinate),Body:original,IfNoneMatch:"*"})),(error:any)=>error.$metadata?.httpStatusCode===412);
    for(const mode of ["bulk-parallel","range","range-prefetch"])assert.equal((await f.recover(b,mode)).sha384,baseline.sha384);
    let puts=0;const observed=f.relay(async(request,next)=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.analogue}`))puts++;return next();});
    const resumed=await f.server(b,{BASINSYNC_BULK_MAX_AGE_MS:"10"},observed);await f.stop(resumed.process);assert.equal(puts,0,"resume adopts an equivalent manifest with a different encoded length");
  }
  // A stronger but corrupt candidate must not install a false prefix or poison fallback.
  const corrupt=encodeBulkOrder(1n,events),offset=boundary(decodeBulkOrder(corrupt).index,11)+rangesAt(events[11])[0].offset;corrupt[offset]^=1;
  await put(1,65,corrupt);
  for(const mode of ["bulk","range","hedged","bulk-parallel","range-parallel","range-prefetch","bidirectional"]){const restored=await f.recover(bucket,mode);assert.equal(restored.sha384,baseline.sha384);}
  await f.s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key(1n,65n)}));
  const malformed=encodeBulkOrder(1n,events);malformed[malformed.length-1]^=1;
  await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:key(1n,66n),Body:malformed}));
  assert.equal((await f.recover(bucket,"bulk")).sha384,baseline.sha384);
  const denied=f.relay(async(request,next)=>new URL(request.url).pathname.includes(`/${objectKeys.analogue}`)?new Response(null,{status:503}):next());
  assert.equal((await f.recover(bucket,"bulk",denied)).sha384,baseline.sha384);
  // Discovery can be arbitrarily slow without preventing direct Timeline progress.
  const gate=Promise.withResolvers<void>();let blocked=false;
  const slow=f.relay(async(request,next)=>{if(new URL(request.url).searchParams.get("prefix")===objectKeys.analogue){blocked=true;await gate.promise;}return next();});
  const fast=await f.recover(bucket,"bulk",slow);assert.equal(fast.sha384,baseline.sha384);assert(blocked);gate.resolve();
  {
    const anchored=await f.bucket();await f.seed(anchored,events.slice(0,16));
    await f.checkpoint(anchored,events.slice(0,16));await f.seed(anchored,events.slice(16),17);
    const body=encodeBulkOrder(1n,events),decoded=decodeBulkOrder(body);
    await f.s3.send(new PutObjectCommand({Bucket:anchored,Key:key(1n,65n),Body:body,Metadata:{"bulkmanifest-range":`bytes=${decoded.range.start}-${decoded.range.end-1}`}}));
    const reads:{path:string;range:string|null}[]=[];
    const observed=f.relay(async(request,next)=>{if(request.method==="GET")reads.push({path:new URL(request.url).pathname,range:request.headers.get("range")});return next();});
    assert.equal((await f.recover(anchored,"range",observed)).sha384,baseline.sha384);
    const twoEnded=await f.recover(anchored,"bidirectional",observed);assert.equal(twoEnded.sha384,baseline.sha384);assert.equal(twoEnded.coordinate,baseline.coordinate);assert.equal(twoEnded.crc32c,baseline.crc32c);
    assert(reads.some(r=>r.path.includes(`/${objectKeys.analogue}`)&&r.range&&Number(r.range.split("-")[0].slice(6))>=boundary(decoded.index,16)&&Number(r.range.split("-")[0].slice(6))<decoded.range.start),"fetch a useful suffix without its checkpointed prefix");
    assert(!reads.some(r=>r.path.includes(`/${objectKeys.timeline}`)&&timelineFromKey(r.path.slice(r.path.indexOf(objectKeys.timeline)))<=16n),"never re-read the snapshot prefix");
    const capped=await f.recover(anchored,"range",undefined,false,{BASINSYNC_RECOVERY_MAX_BYTES:String(decoded.range.start-boundary(decoded.index,16))});assert.equal(capped.sha384,baseline.sha384);assert(capped.stats.bulk_gets>0,"a Range suffix can fit even when the full object exceeds the per-response cap");
    await f.s3.send(new DeleteObjectCommand({Bucket:anchored,Key:key(1n,65n)}));
    for(const [low,high] of [[1,25],[25,41],[41,57],[57,65]]){
      const body=encodeBulkOrder(BigInt(low),events.slice(low-1,high-1)),{range}=decodeBulkOrder(body);
      await f.s3.send(new PutObjectCommand({Bucket:anchored,Key:key(BigInt(low),BigInt(high)),Body:body,Metadata:{"bulkmanifest-range":`bytes=${range.start}-${range.end-1}`}}));
    }
    let individual=0;
    const delayed=f.relay(async(request,next)=>{const url=new URL(request.url);if(url.searchParams.get("prefix")===objectKeys.analogue)await Bun.sleep(40);if(request.method==="GET"&&url.pathname.includes(`/${objectKeys.timeline}`)){individual++;await Bun.sleep(20);}return next();});
    assert.equal((await f.recover(anchored,"bulk",delayed)).sha384,baseline.sha384);
    assert(individual<12,`a speculative discovery frontier must retain orders ending behind it: ${individual} individual GETs`);
  }
  // Complete the second order while the first is blocked. Completed future
  // bodies must occupy a slot, and corruption of the first must not lose them.
  {
    const b=await f.bucket();await f.seed(b,events);
    const bodies=new Map<string,Uint8Array>();
    for(const [low,high] of [[1,17],[17,33],[33,49],[49,65]]){
      const body=encodeBulkOrder(BigInt(low),events.slice(low-1,high-1)),{range}=decodeBulkOrder(body),name=key(BigInt(low),BigInt(high));bodies.set(name,body);
      await f.s3.send(new PutObjectCommand({Bucket:b,Key:name,Body:body,Metadata:{"bulkmanifest-range":`bytes=${range.start}-${range.end-1}`}}));
    }
    for(const fault of ["none","corrupt","unavailable"]){
      const release=Promise.withResolvers<void>();let held=false,second=false,premature=false,active=0,peak=0;
      const observed=f.relay(async(request,next)=>{
        const path=decodeURIComponent(new URL(request.url).pathname);
        if(request.method!=="GET")return next();
        if(path.includes(`/${objectKeys.timeline}`)){await Bun.sleep(40);return next();}
        if(!path.includes(`/${objectKeys.analogue}`))return next();
        active++;peak=Math.max(peak,active);
        try{
          const name=path.slice(path.indexOf(objectKeys.analogue));
          if(name===key(1n,17n)){
            held=true;const response=await next();
            await eventually(async()=>second,yes=>yes,3000);await release.promise;held=false;
            if(fault==="unavailable")return new Response(null,{status:503});
            if(fault!=="corrupt")return response;
            const body=new Uint8Array(await response.arrayBuffer());body[boundary(decodeBulkOrder(body).index,11)+rangesAt(events[11])[0].offset]^=1;return new Response(body,{status:response.status,headers:response.headers});
          }
          const response=await next();
          if(name===key(17n,33n)){second=true;setTimeout(()=>release.resolve(),100);}
          else if(held)premature=true;
          return response;
        }finally{active--;}
      });
      const restored=await f.recover(b,fault==="none"?"default":"bulk-parallel",observed);
      assert.equal(restored.sha384,baseline.sha384);assert(second,"LIST discovers the next order before its predecessor finishes");assert.equal(peak,2);assert(!premature,"a completed future order retains its prefetch slot");assert.equal(restored.stats.peak_bulk_downloads,2);
      assert.equal(restored.stats.rejected_orders,fault==="none"?0:1,"out-of-order completion is buffered, not ingested early");
    }
    // Footer probes can run beyond the two event-data slots. Hold the first
    // data response until every later manifest is available.
    {
      const seen=new Set<string>(),release=Promise.withResolvers<void>();let firstHeld=false,premature=false,activeData=0,peakData=0,heads=0;
      const ahead=f.relay(async(request,next)=>{
        const path=decodeURIComponent(new URL(request.url).pathname);
        if(!path.includes(`/${objectKeys.analogue}`))return next();
        if(request.method==="HEAD"){heads++;return next();}
        if(request.method!=="GET")return next();
        const name=path.slice(path.indexOf(objectKeys.analogue)),bounds=fromKey(name),range=`bytes=${bounds.start}-`;
        if(request.headers.get("range")===range){const response=await next();seen.add(name);if(seen.size===4)setTimeout(()=>release.resolve(),100);return response;}
        activeData++;peakData=Math.max(peakData,activeData);
        try{
          if(bounds.lowest===1n){firstHeld=true;const response=await next();await eventually(async()=>seen.size,n=>n===4,3000);await release.promise;firstHeld=false;return response;}
          if(bounds.lowest>17n&&firstHeld)premature=true;
          return next();
        }finally{activeData--;}
      });
      const restored=await f.recover(b,"range-prefetch",ahead);assert.equal(restored.sha384,baseline.sha384);assert.equal(heads,0);assert.equal(seen.size,4);assert.equal(peakData,2);assert(!premature,"future data remains bounded while manifest probes run ahead");assert(restored.stats.peak_bulk_downloads<=2);assert(restored.stats.peak_manifest_reads<=8);
      const one=await f.recover(b,"range-prefetch",undefined,false,{BASINSYNC_RECOVERY_MANIFEST_CONCURRENCY:"1"});assert.equal(one.sha384,baseline.sha384);assert.equal(one.stats.peak_manifest_reads,1);
    }
    const budget=Math.max(...[...bodies.values()].map(body=>body.length));
    const tight=await f.recover(b,"bulk-parallel",undefined,false,{BASINSYNC_RECOVERY_BULK_BUFFER_BYTES:String(budget)});
    assert.equal(tight.sha384,baseline.sha384);assert(tight.stats.peak_bulk_reserved_bytes<=budget,"in-flight and buffered archives share a byte budget");
    const singles=await f.recover(b,"bulk-parallel",undefined,false,{BASINSYNC_RECOVERY_BULK_CONCURRENCY:"1"});assert.equal(singles.sha384,baseline.sha384);assert.equal(singles.stats.peak_bulk_downloads,1);
    const none=await f.recover(b,"range-parallel",undefined,false,{BASINSYNC_RECOVERY_BULK_BUFFER_BYTES:"1"});assert.equal(none.sha384,baseline.sha384);assert.equal(none.stats.bulk_gets,0,"oversized orders fall back without blocking recovery");
  }
  console.log("put of success: Rust/TS BulkOrder interoperability, overlapping and contained intervals, bounded recovery modes, exact images, range suffixes, corruption fallback, and nonblocking discovery");

  // Hold an archive PUT while later foreground commits fill/drop the byte handoff.
  {
    const b=await f.bucket(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false,sources=0;
    const proxy=f.relay(async(request,next)=>{
      const path=decodeURIComponent(new URL(request.url).pathname);
      if(request.method==="GET"&&path.includes(`/${objectKeys.timeline}`))sources++;
      if(request.method==="PUT"&&path.includes(`/${objectKeys.analogue}`)&&!held){held=true;entered.resolve();await release.promise;}
      return next();
    });
    const app=await f.server(b,{BASINSYNC_BULK_MAX_AGE_MS:"60000",BASINSYNC_BULK_TARGET_BYTES:"1"},proxy);
    assert.equal((await commit(app.url,"live",new Uint8Array([0]),0n)).status,201);await entered.promise;
    for(let n=1;n<8;n++)assert.equal((await commit(app.url,"live",new Uint8Array([n]),BigInt(n))).status,201);
    release.resolve();await f.stop(app.process);assert(sources>0,"overflow catches up from durable Timeline");
    const orders=(await f.s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.analogue}))).Contents!;assert.equal(orders.length,8);
    for(const object of orders){const response=await f.s3.send(new GetObjectCommand({Bucket:b,Key:object.Key!}));const bytes=await response.Body!.transformToByteArray();const {index,events,range}=decodeBulkOrder(bytes);assert.equal(events.length,1);assert.equal(response.Metadata!["bulkmanifest-range"],`bytes=${range.start}-${range.end-1}`);assert.equal(fromKey(object.Key!).start,range.start);const original=await f.s3.send(new GetObjectCommand({Bucket:b,Key:timelineKey(index.lowest)}));assert.deepEqual(events[0],trimRetryMargins(await original.Body!.transformToByteArray()));}
    let puts=0;const observed=f.relay(async(request,next)=>{if(request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.analogue}`))puts++;return next();});
    const resumed=await f.server(b,{BASINSYNC_BULK_MAX_AGE_MS:"10",BASINSYNC_BULK_TARGET_BYTES:"1"},observed);await f.stop(resumed.process);assert.equal(puts,0,"resume existing contiguous archive coverage");
  }
  // Byte threshold, age threshold, final drain, failed uploads, and competing workers.
  {
    const b=await f.bucket(),app=await f.server(b,{BASINSYNC_BULK_MAX_AGE_MS:"60000",BASINSYNC_BULK_TARGET_BYTES:"5242880"});
    for(let n=0;n<64;n++)assert.equal((await commit(app.url,"large",new Uint8Array(98304).fill(n),BigInt(n))).status,201);
    await eventually(()=>f.s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.analogue})),r=>(r.KeyCount??0)>0);
    await f.stop(app.process);const orders=(await f.s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.analogue}))).Contents!;
    const sorted=orders.map(o=>({...fromKey(o.Key!),key:o.Key!})).sort((a,b)=>a.lowest<b.lowest?-1:1);let next=1n;
    for(const order of sorted){assert.equal(order.lowest,next);const response=await f.s3.send(new GetObjectCommand({Bucket:b,Key:order.key}));const decoded=decodeBulkOrder(await response.Body!.transformToByteArray());if(order.highest!==65n)assert(decoded.range.start>=5*1024*1024);next=order.highest;}
    assert.equal(next,65n);assert(sorted.length>=2);
    const restored=await f.recover(b,"bulk");assert.equal(restored.flows.large,"63");
  }
  {
    const b=await f.bucket();let fail=true;const proxy=f.relay(async(request,next)=>request.method==="PUT"&&new URL(request.url).pathname.includes(`/${objectKeys.analogue}`)&&fail?new Response(null,{status:500}):next());
    const app=await f.server(b,{BASINSYNC_BULK_MAX_AGE_MS:"20"},proxy);assert.equal((await commit(app.url,"age",new Uint8Array([1]),0n)).status,201);
    await eventually(async()=>readFileSync(app.log,"utf8"),log=>log.includes("BulkOrder upload will retry"));fail=false;
    await eventually(()=>f.s3.send(new ListObjectsV2Command({Bucket:b,Prefix:objectKeys.analogue})),r=>r.KeyCount===1);
    await f.stop(app.process);
    const source=(await f.s3.send(new GetObjectCommand({Bucket:b,Key:timelineKey(1n)})));const event=await source.Body!.transformToByteArray();
    // New workers can overlap; one conditional winner supplies the same event identities.
    const other=await f.bucket();await f.s3.send(new PutObjectCommand({Bucket:other,Key:timelineKey(1n),Body:event}));
    const apps=await Promise.all([f.server(other,{BASINSYNC_BULK_MAX_AGE_MS:"10"}),f.server(other,{BASINSYNC_BULK_MAX_AGE_MS:"10"})]);await Promise.all(apps.map(app=>f.stop(app.process)));
    assert.equal((await f.s3.send(new ListObjectsV2Command({Bucket:other,Prefix:objectKeys.analogue}))).KeyCount,1);
  }
  console.log(`put of success: byte/age/shutdown flushing, nonblocking bounded handoff, retry, restart, immutable races, and exact archived bytes. Artifacts: ${f.artifacts}`);
}finally{await f.close();}
