[wasm-cpu]: <wasm-cpu.json>

# Rust and Wasm CPU

The same Rust release executable, native aarch64 macOS versus `wasm32-wasip1`
under Node 26.13.1/V8 WASI. Five alternating trials, 20,000 four-byte keys, numeric
values, count aggregation and memory storage. Build includes packing, crypto and
PUTs; 20,000 warmed reads include validation/decoding and return owned values.
The *raw measurements*[~][wasm-cpu] record toolchain and every trial.

| Structure | Native build ms | Wasm build ms | Native reads ms | Wasm reads ms |
|---|---:|---:|---:|---:|
| Trie | 12.9 | 14.8 | 326 | 397 |
| Vector | 15.1 | 19.5 | 389 | 483 |
| B-tree | 6.9 | 8.1 | 409 | 485 |

Wasm reads are roughly 19–24% slower here. This measures the existing stored
Rust readers, not JavaScript logical editors, native editing parity, browser
integration overhead or network throughput. WASI supplies timing and console I/O;
the structures and cryptography execute as Wasm.
