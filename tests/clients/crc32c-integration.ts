import assert from "node:assert/strict";
import {DeleteObjectCommand,GetObjectCommand,HeadObjectCommand,ListObjectsV2Command,PutObjectCommand} from "@aws-sdk/client-s3";
import {fixture} from "./analogue-fixture";
import {commit} from "./client";
import {key} from "./timeline";
import {decodeBulkOrder} from "./bulkorder";
import {trimRetryMargins,coordinateLength} from "./events";
import {append,hex} from "./crc32c";
import { objectKeys } from "./object-keys";
import { passed } from "./scenarios";
import { committedKeys } from "./listing";
const f=await fixture("crc32c");
try {
  const bucket=await f.bucket(),count=12,prefix=[0];let coordinate=0;
  const app=await f.server(bucket,{BASINSYNC_BULK_TARGET_BYTES:"262144",BASINSYNC_BULK_MAX_AGE_MS:"30000"});
  for(let n=0;n<count;n++){const response=await commit(app.url,"crc",new Uint8Array(1024).fill(n),BigInt(n));assert.equal(response.status,201);await response.arrayBuffer();}
  await f.stop(app.process);
  for(let n=1;n<=count;n++){
    const response=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key:key(BigInt(n))})),body=await response.Body!.transformToByteArray();
    assert.equal(response.Metadata!.coordinate,String(coordinate));assert.equal(response.Metadata!["base-crc32c"],hex(prefix[n-1]));
    prefix.push(append(prefix[n-1],trimRetryMargins(body)));coordinate+=coordinateLength(body);
    assert.equal(response.Metadata!.crc32c,hex(prefix[n]));
  }
  async function verifyOrders(){
    const orders=await committedKeys(f.s3,bucket,objectKeys.analogue);assert(orders.length>1);
    for(const Key of orders){
      const response=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key})),body=await response.Body!.transformToByteArray(),{index,range}=decodeBulkOrder(body),low=Number(index.lowest),high=low+index.ends.length;
      assert.equal(response.Metadata!["base-crc32c"],hex(prefix[low-1]));assert.equal(response.Metadata!.crc32c,hex(prefix[high-1]));
      assert.equal(append(prefix[low-1],body.subarray(0,range.start)),prefix[high-1]);
    }
  }
  await verifyOrders();
  for(const mode of ["sequential","bulk-parallel","range-prefetch","bidirectional"]){const recovered=await f.recover(bucket,mode);assert.equal(recovered.crc32c,hex(prefix[count]));}
  const events=[];for(let n=1;n<=count;n++){const r=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key:key(BigInt(n))}));events.push(await r.Body!.transformToByteArray());}
  const checkpoint=await f.checkpoint(bucket,events);
  assert.equal(checkpoint.Metadata!.crc32c,hex(prefix[count]));assert.equal(checkpoint.Metadata!.coordinate,String(coordinate));
  // Snapshot-only recovery retains the whole-run CRC after older Timeline entries disappear.
  for(let n=1;n<=count;n++)await f.s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key(BigInt(n))}));
  assert.equal((await f.recover(bucket,"bulk-parallel")).crc32c,hex(prefix[count]));
  const resumed=await f.server(bucket,{BASINSYNC_BULK_TARGET_BYTES:"262144",BASINSYNC_BULK_MAX_AGE_MS:"30000"});
  const response=await commit(resumed.url,"crc",new Uint8Array([99]),BigInt(count));assert.equal(response.status,201);await response.arrayBuffer();await f.stop(resumed.process);
  const next=await f.s3.send(new GetObjectCommand({Bucket:bucket,Key:key(BigInt(count+1))})),body=await next.Body!.transformToByteArray();prefix.push(append(prefix[count],trimRetryMargins(body)));
  assert.equal(next.Metadata!["base-crc32c"],hex(prefix[count]));assert.equal(next.Metadata!.crc32c,hex(prefix[count+1]));await verifyOrders();
  for(const mode of ["sequential","bulk-parallel","range-prefetch","bidirectional"])assert.equal((await f.recover(bucket,mode)).crc32c,hex(prefix[count+1]));
  await f.s3.send(new PutObjectCommand({Bucket:bucket,Key:key(BigInt(count+1)),Body:body,Metadata:{...next.Metadata,crc32c:hex(prefix[count+1]^1)}}));
  await assert.rejects(()=>f.recover(bucket,"sequential"),/CRC32C/);
  passed("0zg4 timeline recovery", `independent cumulative CRC32C verification, Timeline and BulkOrder metadata, archive restart, snapshot-only seeding, continuation, and corrupt-checksum rejection. Artifacts: ${f.artifacts}`);
}finally{await f.close();}
