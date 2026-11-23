import assert from "node:assert/strict";
import {mkdirSync,readdirSync,statSync,openSync,writeSync,closeSync} from "node:fs";
import {PutObjectCommand} from "@aws-sdk/client-s3";
import {fixture,eventually} from "./analogue-fixture";
import {encodeBulkOrder,decodeBulkOrder,key,coordinateLength} from "./bulkorder";
import {fromKey} from "./timeline";
import {trimRetryMargins,manifestRange} from "./events";
import {wrap,concat,MARGIN,NESTED} from "./envbuf";
import { objectKeys } from "./object-keys";
const f=await fixture("bidirectional");
try {
  const events=await f.generate(64,4096),plain=await f.bucket();await f.seed(plain,events);
  const expected=await f.recover(plain,"sequential");assert.equal(expected.coordinate,String(events.reduce((n,e)=>n+coordinateLength(e),0)));
  async function archived(high:number){const bucket=await f.bucket();await f.seed(bucket,events);const body=encodeBulkOrder(1n,events.slice(0,high)),{index,range}=decodeBulkOrder(body);await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:key(1n,BigInt(high+1),range.start,index.coordinate),Body:body}));return bucket;}
  {
    const bucket=await archived(48),proxy=f.relay(async(request,next)=>{const path=new URL(request.url).pathname;if(request.method==="GET")await Bun.sleep(path.includes(`/${objectKeys.analogue}`)?40:3);return next();});
    const result=await f.recover(bucket,"bidirectional",proxy);assert.equal(result.sha384,expected.sha384);assert(result.stats.cache_hits>0);assert(result.stats.coordinate_range_gets>0);assert.equal(result.stats.manifest_gets,0);assert(result.stats.peak_bulk_downloads<=2);
  }
  // The same events can have different physical retry tails without shifting coordinates.
  {
    const variants=events.map((event,i)=>{
      const plain=trimRetryMargins(event);
      const margins=i%3===0?[]:i%3===1?[wrap(new Uint8Array(i%17),MARGIN)]:[wrap(new Uint8Array(1),MARGIN),wrap(new Uint8Array(i%31),MARGIN)];
      const bytes=concat([plain,...margins]);
      assert.equal(coordinateLength(bytes),coordinateLength(event));if(!margins.length)assert.equal(coordinateLength(bytes),bytes.length);
      return bytes;
    });
    const bucket=await f.bucket();await f.seed(bucket,events);
    const body=encodeBulkOrder(1n,variants),{index,range}=decodeBulkOrder(body);
    assert.equal(BigInt(index.ends.at(-1)!),BigInt(expected.coordinate));
    await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:key(1n,65n,range.start,index.coordinate),Body:body}));
    for(const mode of ["bulk-parallel","range","range-prefetch","bidirectional"]){
      const result=await f.recover(bucket,mode);assert.equal(result.sha384,expected.sha384);assert.equal(result.coordinate,expected.coordinate);assert(result.stats.bulk_gets>0);
    }
  }
  // Let descending reads establish a retained suffix before archive discovery completes.
  {
    const bucket=await archived(64),gate=Promise.withResolvers<void>(),ranges:string[]=[];
    const total=events.reduce((n,e)=>n+e.length,0);
    const proxy=f.relay(async(request,next)=>{const url=new URL(request.url);
      if(url.searchParams.get("prefix")===objectKeys.analogue)await gate.promise;
      if(request.method==="GET"&&url.pathname.includes(`/${objectKeys.timeline}`)){
        const m=fromKey(url.pathname.slice(url.pathname.indexOf(objectKeys.timeline)));await Bun.sleep(3);
        if(m===60n)setTimeout(()=>gate.resolve(),20);
      }
      if(request.method==="GET"&&url.pathname.includes(`/${objectKeys.analogue}`))ranges.push(request.headers.get("range")!);
      return next();
    });
    try{const result=await f.recover(bucket,"bidirectional",proxy);assert.equal(result.sha384,expected.sha384);assert(result.stats.cache_hits>=4);assert(ranges.some(r=>/^bytes=\d+-\d+$/.test(r)&&Number(r.split("-")[1])<total-1));assert(!ranges.some(r=>r.endsWith("-")),"trimmed events let coordinates translate without manifest GETs");}finally{gate.resolve();}
  }
  // Neither a permanently held archive GET nor a one-byte disk budget may stall scanning/recovery.
  {
    const bucket=await archived(64);let held=0;const gate=Promise.withResolvers<void>();
    const proxy=f.relay(async(request,next)=>{const path=new URL(request.url).pathname;if(request.method==="GET"&&path.includes(`/${objectKeys.analogue}`)){held++;await gate.promise;}if(path.includes(`/${objectKeys.timeline}`))await Bun.sleep(2);return next();});
    let timer:ReturnType<typeof setTimeout>;
    try {const result=await Promise.race([f.recover(bucket,"bidirectional",proxy,false,{BASINSYNC_RECOVERY_DISK_BYTES:"1"}),new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error("held archive stalled Timeline recovery")),5000);})]);assert.equal(result.sha384,expected.sha384);assert(held>0);assert(result.stats.descending_gets>=60);assert.equal(result.stats.cache_hits,0);}finally{clearTimeout(timer!);gate.resolve();}
  }
  {
    const cap=Math.max(...events.map(e=>e.length))*3;
    const proxy=f.relay(async(request,next)=>{const path=new URL(request.url).pathname;if(request.method==="GET"&&path.includes(`/${objectKeys.timeline}`)){const m=fromKey(path.slice(path.indexOf(objectKeys.timeline)));await Bun.sleep(m<8n?30:1);}return next();});
    const result=await f.recover(plain,"bidirectional",proxy,false,{BASINSYNC_RECOVERY_DISK_BYTES:String(cap),BASINSYNC_RECOVERY_DISK_SEGMENT_BYTES:"1"});assert.equal(result.sha384,expected.sha384);assert(result.stats.cache_evictions>0);assert(result.stats.peak_disk_bytes<=cap);
    const none=await f.recover(plain,"bidirectional",undefined,false,{BASINSYNC_RECOVERY_DISK_DIRECTORY:`${f.artifacts}/does-not-exist`});assert.equal(none.sha384,expected.sha384);assert.equal(none.stats.peak_disk_bytes,0);
  }
  // Damage cached event 64 while an early archive request is pending. Refetch rather than ingest it.
  {
    const bucket=await archived(48),directory=`${f.artifacts}/cache`;mkdirSync(directory);
    const proxy=f.relay(async(request,next)=>{const path=new URL(request.url).pathname;if(request.method==="GET")await Bun.sleep(path.includes(`/${objectKeys.analogue}`)?900:3);return next();});
    const pending=f.recover(bucket,"bidirectional",proxy,false,{BASINSYNC_RECOVERY_DISK_DIRECTORY:directory});
    const path=await eventually(async()=>{const folder=readdirSync(directory)[0];if(!folder)return null;const segment=readdirSync(`${directory}/${folder}`)[0];if(!segment)return null;const path=`${directory}/${folder}/${segment}`;return statSync(path).size>=events.at(-1)!.length?path:null;},p=>p!==null);
    const fd=openSync(path!,"r+");try{writeSync(fd,new Uint8Array([0]),0,1,0);}finally{closeSync(fd);}
    const result=await pending;assert.equal(result.sha384,expected.sha384);assert(result.stats.cache_misses>0);
  }
  console.log(`put of success: bidirectional recovery, bounded eviction/refetch, checksum failure, unavailable disk, held archive reads, and byte-coordinate ranges. Artifacts: ${f.artifacts}`);
} finally {await f.close();}
