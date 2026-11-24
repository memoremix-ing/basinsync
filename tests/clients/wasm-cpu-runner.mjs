import { WASI } from "node:wasi";
import { readFileSync } from "node:fs";
const wasi = new WASI({version:"preview1",args:["cpu"],env:{},preopens:{},returnOnExit:true});
const module = await WebAssembly.compile(readFileSync(process.argv[2]));
const instance = await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport});
wasi.start(instance);
