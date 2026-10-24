import assert from "node:assert/strict";

export function ingestWal(before:Uint8Array,segments:Uint8Array[]):Uint8Array {
  assert(segments.length>0);let image=new Uint8Array(before);
  for(const bytes of segments){
    assert(bytes.length>=32 && (bytes.length-32)%(16384+24)===0);
    const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const magic=header.getUint32(0);assert(magic===0x377f0682 || magic===0x377f0683);
    assert.equal(header.getUint32(4),3007000);assert.equal(header.getUint32(8),16384);
    const little=magic===0x377f0682;
    let s0=0,s1=0;
    function fold(data:Uint8Array){const view=new DataView(data.buffer,data.byteOffset,data.byteLength);assert.equal(data.length%8,0);for(let n=0;n<data.length;n+=8){s0=(s0+view.getUint32(n,little)+s1)>>>0;s1=(s1+view.getUint32(n+4,little)+s0)>>>0}}
    fold(bytes.subarray(0,24));assert.equal(s0,header.getUint32(24));assert.equal(s1,header.getUint32(28));
    const pending=new Map<number,Uint8Array>();let committed=false;
    for(let pos=32;pos<bytes.length;pos+=16384+24){
      const frame=bytes.subarray(pos,pos+16384+24),view=new DataView(frame.buffer,frame.byteOffset,frame.byteLength);
      const page=view.getUint32(0),size=view.getUint32(4);assert(page>0);
      assert.deepEqual(frame.subarray(8,16),bytes.subarray(16,24));
      fold(frame.subarray(0,8));fold(frame.subarray(24));
      assert.equal(s0,view.getUint32(16));assert.equal(s1,view.getUint32(20));
      pending.set(page,frame.subarray(24));committed=size>0;
      if(committed){
        const length=size*16384;assert(length<=image.length+pending.size*16384);
        const next=new Uint8Array(length);next.set(image.subarray(0,length));
        for(const [page,data] of pending)if(page<=size)next.set(data,(page-1)*16384);
        image=next;pending.clear();
      }
    }
    assert(committed && pending.size===0,"uncommitted WAL tail");
  }
  return image;
}
