import assert from "node:assert/strict";
export type Envelope={start:number;contentStart:number;end:number;format:number;content:Uint8Array};
export function wrap(content:Uint8Array,format=5):Uint8Array {
  assert(content.length<=0xffffffff && [0,4,5].includes(format));
  const footer=8+Math.ceil(content.length/8)*8,bytes=new Uint8Array(footer+8),view=new DataView(bytes.buffer);
  bytes.set([0x65,0x6e,0x56,(format<<5)|3]);view.setUint32(4,content.length,true);
  bytes.set(content,8);bytes.fill(0xee,8+content.length,footer);view.setUint32(footer,content.length,true);bytes.set([(format<<5)|3,0x76,0x4e,0x45],footer+4);return bytes;
}
export function at(bytes:Uint8Array,start:number):Envelope {
  assert(Number.isSafeInteger(start)&&start>=0&&start%8===0&&start+8<=bytes.length,"invalid EnvBuf header boundary");
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),descriptor=bytes[start+3],format=descriptor>>5;
  assert(bytes[start]===0x65&&bytes[start+1]===0x6e&&bytes[start+2]===0x56&&(descriptor&31)===3&&[0,4,5].includes(format),"invalid EnvBuf header");
  const length=view.getUint32(start+4,true),contentStart=start+8,footer=contentStart+Math.ceil(length/8)*8,end=footer+8;
  assert(end<=bytes.length&&view.getUint32(footer,true)===length&&bytes[footer+4]===descriptor&&bytes[footer+5]===0x76&&bytes[footer+6]===0x4e&&bytes[footer+7]===0x45,"invalid EnvBuf footer");
  assert(bytes.subarray(contentStart+length,footer).every(b=>b===0xee),"invalid EnvBuf padding");
  return {start,contentStart,end,format,content:bytes.subarray(contentStart,contentStart+length)};
}
export function before(bytes:Uint8Array,end:number):Envelope {
  assert(Number.isSafeInteger(end)&&end>=8&&end<=bytes.length&&end%8===0);
  const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(end-8,true);
  const frame=at(bytes,end-16-Math.ceil(length/8)*8);assert.equal(frame.end,end);return frame;
}
export function all(bytes:Uint8Array):Envelope[]{const frames:Envelope[]=[];let pos=0;while(pos<bytes.length){const frame=at(bytes,pos);frames.push(frame);pos=frame.end;}return frames;}
export function concat(chunks:Uint8Array[]):Uint8Array {const result=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;}
