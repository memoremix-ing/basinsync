// Independent reference implementation; the server uses the hardware-accelerated Rust crate.
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0x82f63b78:0);return n>>>0;});
export function append(crc:number,bytes:Uint8Array):number {let value=(crc^0xffffffff)>>>0;for(const byte of bytes)value=(table[(value^byte)&255]^(value>>>8))>>>0;return (value^0xffffffff)>>>0;}
export function hex(crc:number):string{return (crc>>>0).toString(16).padStart(8,"0");}
