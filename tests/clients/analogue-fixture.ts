import assert from "node:assert/strict";
import {mkdirSync,mkdtempSync,openSync,closeSync,readFileSync} from "node:fs";
import {createServer} from "node:net";
import {resolve} from "node:path";
import {spawn} from "bun";
import {S3Client,CreateBucketCommand,ListBucketsCommand,PutObjectCommand,HeadObjectCommand} from "@aws-sdk/client-s3";
import {s3Fixture} from "./s3-fixture";
import {key} from "./timeline";
import {all,wrap,concat,MARGIN} from "./envbuf";
import {deltasAt,coordinateLength,trimRetryMargins,entryDigest,type WalDelta} from "./events";
import {ingestWal} from "./wal";
import {encode as lex} from "./lexidecimal";
import {encode as flexEncode} from "./flexbuffer";
import {sha384} from "./client";
import {append as crcAppend,hex as crcHex} from "./crc32c";
import { objectKeys } from "./object-keys";

export async function eventually<T>(call:()=>Promise<T>,accept:(value:T)=>boolean,ms=15000):Promise<T>{
  const end=Date.now()+ms;let error:unknown;
  while(Date.now()<end){try{const value=await call();if(accept(value))return value;}catch(e){error=e;}await Bun.sleep(10);}
  throw new Error(`deadline exceeded: ${error??"condition not met"}`);
}
async function freePort(){const server=createServer();await new Promise<void>((yes,no)=>{server.once("error",no);server.listen(0,"127.0.0.1",yes);});const address=server.address();assert(address&&typeof address!=="string");await new Promise<void>(yes=>server.close(()=>yes()));return address.port;}

export async function fixture(label="analogue"){
  const root=resolve(import.meta.dir,"../..");mkdirSync(`${root}/.local`,{recursive:true});
  const artifacts=mkdtempSync(`${root}/.local/${label}-`),children:ReturnType<typeof spawn>[]=[],relays:ReturnType<typeof Bun.serve>[]=[];
  const endpoint=`http://127.0.0.1:${await freePort()}`,credentials={accessKeyId:"analogue-test",secretAccessKey:"analogue-test-secret"};let serial=0;
  const env={AWS_REGION:"us-east-1",AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,AWS_SESSION_TOKEN:"",S3_ENDPOINT:endpoint};
  function launch(command:string[],extra:Record<string,string>){const log=`${artifacts}/process-${serial++}.log`,fd=openSync(log,"w");const process=spawn(command,{cwd:root,env:{...Bun.env,...env,...extra},stdout:fd,stderr:fd});closeSync(fd);children.push(process);return {process,log};}
  const s3=new S3Client({endpoint,region:"us-east-1",credentials,forcePathStyle:true,maxAttempts:1});
  const fs=s3Fixture(root,endpoint,`${artifacts}/objects`,credentials);const provider=launch(fs.command,fs.env);
  await eventually(()=>s3.send(new ListBucketsCommand({})),()=>true);
  async function bucket(){const name=`analogue-test-${serial++}`;await s3.send(new CreateBucketCommand({Bucket:name}));return name;}
  async function stop(child:ReturnType<typeof spawn>){if(child.exitCode!==null)return;child.kill("SIGINT");let timer:ReturnType<typeof setTimeout>;try{await Promise.race([child.exited,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error("shutdown timed out")),32000);})]);}finally{clearTimeout(timer!);}assert.equal(child.exitCode,0);}
  async function server(Bucket:string,extra:Record<string,string>={},s3Endpoint=endpoint,release=false){
    const address=`127.0.0.1:${await freePort()}`;
    const app=launch([`${root}/target/${release?"release":"debug"}/basinsync`],{S3_BUCKET:Bucket,S3_ENDPOINT:s3Endpoint,BASINSYNC_LISTEN:address,BASINSYNC_BATCH_MAX:"1",BASINSYNC_BATCH_WAIT_MS:"0",BASINSYNC_CLEANUP_INTERVAL_MS:"0",BASINSYNC_BACKUP_INTERVAL_MS:"0",BASINSYNC_BULK_MAX_AGE_MS:"0",BASINSYNC_STATUS_PROBE_MAX_AGE_MS:"0",...extra});
    const url=`http://${address}`;
    await eventually(async()=>{assert.equal(app.process.exitCode,null,readFileSync(app.log,"utf8"));return fetch(`${url}/ready`);},r=>r.status===404);
    return {...app,url};
  }
  function relay(handler:(request:Request,next:()=>Promise<Response>)=>Promise<Response>){const proxy=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:0,async fetch(request){const url=new URL(request.url);return handler(request,()=>fetch(`${endpoint}${url.pathname}${url.search}`,{method:request.method,headers:request.headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,redirect:"manual"}));}});relays.push(proxy);return `http://127.0.0.1:${proxy.port}`;}
  async function binary(args:string[],extra:Record<string,string>={},input?:Uint8Array,release=false){
    const process=spawn([`${root}/target/${release?"release":"debug"}/examples/recovery-fixture`,...args],{cwd:root,env:{...Bun.env,...env,...extra},stdin:input?"pipe":"ignore",stdout:"pipe",stderr:"pipe"});
    if(input){await process.stdin!.write(input);process.stdin!.end();}
    const [bytes,error,code]=await Promise.all([new Response(process.stdout).arrayBuffer(),new Response(process.stderr).text(),process.exited]);assert.equal(code,0,error);return new Uint8Array(bytes);
  }
  async function recover(Bucket:string,mode:string,s3Endpoint=endpoint,release=false,extra:Record<string,string>={}){return JSON.parse(new TextDecoder().decode(await binary(mode==="default"?["--recover"]:["--recover",mode],{S3_BUCKET:Bucket,S3_ENDPOINT:s3Endpoint,...extra},undefined,release))) as {kernel_sha384:string|null;crc32c:string;coordinate:string;elapsed_ms:number;milestone:string;sha384:string;flows:Record<string,string>;stats:{cache_evictions:number;peak_disk_bytes:number;descending_gets:number;cache_hits:number;cache_bypasses:number;cache_misses:number;coordinate_range_gets:number;peak_bulk_downloads:number;peak_bulk_reserved_bytes:number;rejected_orders:number;bulk_gets:number;manifest_gets:number;peak_manifest_reads:number}};}
  async function generate(count:number,size:number){const bytes=await binary(["--generate",String(count),String(size)]);const frames=all(bytes).filter(frame=>frame.format===4);return frames.map((frame,i)=>bytes.slice(frame.start,frames[i+1]?.start??bytes.length));}
  async function seed(Bucket:string,events:Uint8Array[],lowest=1){let next=0;await Promise.all(Array.from({length:4},async()=>{while(next<events.length){const n=next++;await s3.send(new PutObjectCommand({Bucket,Key:key(BigInt(n+lowest)),Body:events[n],IfNoneMatch:"*"}));}}));}
  // A fixed-prefix test fixture: no live backup producer may occupy the seeded suffix.
  async function checkpoint(Bucket:string,events:Uint8Array[]){
    const images:Record<string,Uint8Array>={};let coordinate=0,crc32c=0;
    for(const event of events){
      for(const [id,raw] of Object.entries(deltasAt(event).turso)){const delta=raw as WalDelta;images[id]=ingestWal(images[id]??delta.logical.base!,delta.physical.segments);}
      coordinate+=coordinateLength(event);crc32c=crcAppend(crc32c,trimRetryMargins(event));
    }
    const databases:Record<string,{id:string;revision:string;length:number;sha384:string}>={};
    for(const [name,image] of Object.entries(images)){
      const token=crypto.getRandomValues(new Uint8Array(16)),node={id:`n-${lex(-1n)}/v.${lex(0n)}/t.${lex(16n)}/d_${sha384(token)}`,revision:crypto.randomUUID(),length:image.length,sha384:sha384(image)};databases[name]=node;
      await s3.send(new PutObjectCommand({Bucket,Key:`${objectKeys.kernelHeap}young/${node.id}/${node.revision}`,Body:image,Metadata:{sha384:node.sha384}}));
    }
    assert.deepEqual(Object.keys(databases).sort(),["default.turso","kernel.turso"]);
    const graph={version:deltasAt(events.at(-1)!).turso["default.turso"].version,milestone:String(events.length),coordinate:String(coordinate),crc32c:crcHex(crc32c),parent:entryDigest(events.at(-1)!),databases};
    const blob=new Uint8Array(flexEncode(graph)),Key=`${objectKeys.basinEpilogue}${lex(-1n)}`;
    await s3.send(new PutObjectCommand({Bucket,Key,Body:concat([wrap(blob,0),wrap(new Uint8Array(8),MARGIN)]),Metadata:{milestone:graph.milestone,coordinate:graph.coordinate,crc32c:graph.crc32c,"event-sha384":graph.parent,sha384:sha384(blob),"turso-version":graph.version}}));
    return s3.send(new HeadObjectCommand({Bucket,Key}));
  }
  async function close(){for(const child of children.reverse()){if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}for(const relay of relays)await relay.stop(true);s3.destroy();}
  return {root,artifacts,endpoint,s3,env,bucket,server,stop,relay,binary,recover,generate,seed,checkpoint,close,provider};
}
