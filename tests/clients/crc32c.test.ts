import {test,expect} from "bun:test";
import {append,hex} from "./crc32c";
test("CRC32C standard check vector and cumulative continuation",()=>{
  const bytes=new TextEncoder().encode("123456789");expect(hex(append(0,bytes))).toBe("e3069283");expect(hex(append(0,new Uint8Array()))).toBe("00000000");
  for(let i=0;i<=bytes.length;i++)expect(append(append(0,bytes.subarray(0,i)),bytes.subarray(i))).toBe(append(0,bytes));
});
